package smartrecruiters

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"jobhunt-engine/internal/domain"
	"jobhunt-engine/internal/scrape/types"
	"jobhunt-engine/internal/scrape/util"
)

type Config struct {
	Companies []Company
}

type Company struct {
	// Slug is the SmartRecruiters company identifier used in URLs, e.g.
	// https://jobs.smartrecruiters.com/<slug>
	Slug string
	Name string
}

type Scraper struct {
	cfg     Config
	hc      *http.Client
	limiter *util.HostLimiter
}

func New(cfg Config, limiter *util.HostLimiter) *Scraper {
	return &Scraper{
		cfg:     cfg,
		hc:      &http.Client{Timeout: 25 * time.Second},
		limiter: limiter,
	}
}

func (s *Scraper) Name() string { return "smartrecruiters" }

// Response schema (public API) is typically:
// { "content": [...], "totalFound": N, "offset": O, "limit": L }
// but we defensively parse only what we need.
type postingsResponse struct {
	Content    []posting `json:"content"`
	TotalFound int       `json:"totalFound"`
	Offset     int       `json:"offset"`
	Limit      int       `json:"limit"`
}

type posting struct {
	ID           string    `json:"id"`
	UUID         string    `json:"uuid"`
	Name         string    `json:"name"`
	ReleasedDate time.Time `json:"releasedDate"`
	Ref          string    `json:"ref"`
	Location     struct {
		City    string `json:"city"`
		Region  string `json:"region"`
		Country string `json:"country"`
	} `json:"location"`
	CustomField string `json:"customField"`
}

func (s *Scraper) Fetch(ctx context.Context) (types.ScrapeResult, error) {
	const workers = 8

	companies := s.cfg.Companies
	jobsCh := make(chan []domain.JobLead, len(companies))
	workCh := make(chan Company)

	var wg sync.WaitGroup
	wg.Add(workers)

	for i := 0; i < workers; i++ {
		go func() {
			defer wg.Done()
			for co := range workCh {
				cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
				jobs, err := s.fetchCompany(cctx, co)
				cancel()
				if err != nil {
					log.Printf("[ats:smartrecruiters] company=%q slug=%q err=%v", co.Name, co.Slug, err)
					continue
				}
				if len(jobs) > 0 {
					jobsCh <- jobs
				}
			}
		}()
	}

	go func() {
		defer close(workCh)
		for _, co := range companies {
			select {
			case <-ctx.Done():
				return
			case workCh <- co:
			}
		}
	}()

	wg.Wait()
	close(jobsCh)

	var out []domain.JobLead
	for batch := range jobsCh {
		out = append(out, batch...)
	}

	log.Printf("[smartrecruiters] Processed: %d", len(out))
	return types.ScrapeResult{Source: "smartrecruiters", Leads: out}, nil
}

func (s *Scraper) fetchCompany(ctx context.Context, co Company) ([]domain.JobLead, error) {
	slug := strings.TrimSpace(co.Slug)
	if slug == "" {
		return nil, fmt.Errorf("empty slug")
	}

	// Public API endpoint.
	// Example: https://api.smartrecruiters.com/v1/companies/<slug>/postings?limit=100&offset=0
	base := fmt.Sprintf("https://api.smartrecruiters.com/v1/companies/%s/postings", url.PathEscape(slug))

	limit := 100
	offset := 0
	var out []domain.JobLead

	for {
		select {
		case <-ctx.Done():
			return out, ctx.Err()
		default:
		}

		u := fmt.Sprintf("%s?limit=%d&offset=%d", base, limit, offset)
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
		req.Header.Set("User-Agent", "JobHunt/1.0 (+local)")
		req.Header.Set("Accept", "application/json")

		if s.limiter != nil {
			if err := s.limiter.WaitURL(ctx, u); err != nil {
				return out, err
			}
		}

		res, err := s.hc.Do(req)
		if err != nil {
			return out, fmt.Errorf("smartrecruiters get: %w", err)
		}
		defer res.Body.Close()
		if res.StatusCode >= 400 {
			return out, fmt.Errorf("smartrecruiters status %d", res.StatusCode)
		}

		var pr postingsResponse
		if err := json.NewDecoder(res.Body).Decode(&pr); err != nil {
			return out, fmt.Errorf("smartrecruiters decode: %w", err)
		}

		if len(pr.Content) == 0 {
			break
		}

		for _, p := range pr.Content {
			title := strings.TrimSpace(p.Name)
			id := strings.TrimSpace(firstNonEmpty(p.ID, p.UUID, p.Ref))
			if title == "" || id == "" {
				continue
			}
			jobURL := fmt.Sprintf("https://jobs.smartrecruiters.com/%s/%s", slug, id)

			loc := strings.TrimSpace(strings.Join(nonEmpty(p.Location.City, p.Location.Region, p.Location.Country), ", "))
			loc = util.NormalizeLocation(loc)
			mode := util.InferWorkModeFromText(loc, title, "")

			posted := p.ReleasedDate
			var postedAt *time.Time
			if !posted.IsZero() {
				postedAt = &posted
			}

			out = append(out, domain.JobLead{
				CompanyName:     co.Name,
				Title:           title,
				LocationRaw:     loc,
				WorkMode:        mode,
				URL:             jobURL,
				PostedAt:        postedAt,
				FirstSeenSource: "SmartRecruiters",
				ATSJobID:        fmt.Sprintf("smartrecruiters:%s:%s", slug, id),
			})
		}

		offset += limit
		if pr.TotalFound > 0 && offset >= pr.TotalFound {
			break
		}
		if offset > 5000 {
			break
		}
	}

	return out, nil
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func nonEmpty(vals ...string) []string {
	out := make([]string, 0, len(vals))
	for _, v := range vals {
		v = strings.TrimSpace(v)
		if v != "" {
			out = append(out, v)
		}
	}
	return out
}
