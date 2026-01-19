package workday

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"jobhunt-engine/internal/domain"
	"jobhunt-engine/internal/scrape/types"
	"jobhunt-engine/internal/scrape/util"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Config struct {
	Companies []Company
}

type Company struct {
	Slug string // Needs full Workday job board URL
	Name string
}

type Scraper struct {
	cfg     Config
	hc      *http.Client
	limiter *util.HostLimiter
}

type board struct {
	Scheme string
	Host   string
	Tenant string
	Site   string
}

func New(cfg Config, limiter *util.HostLimiter) *Scraper {
	return &Scraper{
		cfg:     cfg,
		hc:      &http.Client{Timeout: 20 * time.Second},
		limiter: limiter,
	}
}

func (s *Scraper) Name() string { return "workday" }

type WDRequest struct {
	AppliedFacets map[string]any `json:"appliedFacets"`
	Limit         int            `json:"limit"`
	Offset        int            `json:"offset"`
	SearchText    string         `json:"searchText"`
}

type WDResponse struct {
	Total       int         `json:"total"`
	JobPostings []WDPosting `json:"jobPostings"`
}

type WDPosting struct {
	ID               string `json:"id"`
	Title            string `json:"title"`
	ExternalPath     string `json:"externalPath"`
	ExternalURL      string `json:"externalUrl"`
	LocationsText    string `json:"locationsText"`
	Location         string `json:"location"`
	PostedOn         string `json:"postedOn"`
	PostedOnDate     string `json:"postedOnDate"`
	JobReqID         string `json:"jobRequisitionId"`
	JobRequisitionID string `json:"jobRequisitionID"`
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
					log.Printf("[ats:workday] company=%q slug=%q err=%v", co.Name, co.Slug, err)
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

	log.Printf("[workday] Processed: %d", len(out))
	return types.ScrapeResult{Source: "workday", Leads: out}, nil
}

func parseBoardURL(raw string) (board, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return board{}, errors.New("empty board URL")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return board{}, err
	}
	if u.Scheme == "" {
		u.Scheme = "https"
	}
	if u.Host == "" {
		return board{}, fmt.Errorf("missing host in %q", raw)
	}
	parts := strings.Split(u.Host, ".")
	if len(parts) < 3 {
		return board{}, fmt.Errorf("unexpected host %q", u.Host)
	}
	tenant := parts[0]
	segs := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(segs) == 0 {
		return board{}, fmt.Errorf("unexpected path %q", u.Path)
	}
	site := segs[len(segs)-1]
	if site == "" {
		return board{}, fmt.Errorf("could not derive site from path %q", u.Path)
	}
	return board{Scheme: u.Scheme, Host: u.Host, Tenant: tenant, Site: site}, nil
}

func (b board) jobsEndpoint() string {
	return fmt.Sprintf("%s://%s/wday/cxs/%s/%s/jobs", b.Scheme, b.Host, b.Tenant, b.Site)
}

func (b board) absoluteJobURL(p WDPosting) string {
	if p.ExternalURL != "" {
		return strings.TrimSpace(p.ExternalURL)
	}
	path := strings.TrimSpace(p.ExternalPath)
	if path == "" {
		return ""
	}
	if strings.HasPrefix(path, "http://") || strings.HasPrefix(path, "https://") {
		return path
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	return fmt.Sprintf("%s://%s%s", b.Scheme, b.Host, path)
}

func (s *Scraper) fetchCompany(ctx context.Context, co Company) ([]domain.JobLead, error) {
	b, err := parseBoardURL(co.Slug)
	if err != nil {
		return nil, err
	}
	endpoint := b.jobsEndpoint()

	limit := 50
	offset := 0
	var out []domain.JobLead

	for {
		select {
		case <-ctx.Done():
			return out, ctx.Err()
		default:
		}

		body := WDRequest{
			AppliedFacets: map[string]any{},
			Limit:         limit,
			Offset:        offset,
			SearchText:    "",
		}
		payload, _ := json.Marshal(body)

		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
		req.Header.Set("User-Agent", "JobHunt/1.0 (+local)")
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json")

		if s.limiter != nil {
			if err := s.limiter.WaitURL(ctx, endpoint); err != nil {
				return out, err
			}
		}

		res, err := s.hc.Do(req)
		if err != nil {
			return out, fmt.Errorf("workday post jobs: %w", err)
		}
		data, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if res.StatusCode >= 400 {
			return out, fmt.Errorf("workday status %d body=%s", res.StatusCode, truncate(string(data), 240))
		}

		var jr WDResponse
		if err := json.Unmarshal(data, &jr); err != nil {
			return out, fmt.Errorf("workday decode: %w body=%s", err, truncate(string(data), 240))
		}

		if len(jr.JobPostings) == 0 {
			break
		}

		for _, p := range jr.JobPostings {
			title := strings.TrimSpace(p.Title)
			jobURL := b.absoluteJobURL(p)
			if title == "" || jobURL == "" {
				continue
			}

			loc := strings.TrimSpace(firstNonEmpty(p.LocationsText, p.Location))
			loc = util.NormalizeLocation(loc)

			jobID := strings.TrimSpace(firstNonEmpty(p.JobReqID, p.JobRequisitionID, p.ID))
			if jobID == "" {
				jobID = util.HashString("url:" + strings.TrimSpace(jobURL))
			}

			sourceID := fmt.Sprintf("workday:%s:%s:%s", b.Tenant, b.Site, jobID)

			postedAt := parseWorkdayPostedAt(p.PostedOnDate)
			mode := util.InferWorkModeFromText(loc, title, "")

			out = append(out, domain.JobLead{
				CompanyName:     co.Name,
				Title:           title,
				LocationRaw:     loc,
				WorkMode:        mode,
				URL:             jobURL,
				PostedAt:        postedAt,
				FirstSeenSource: "Workday",
				ATSJobID:        sourceID,
			})
		}

		offset += limit
		if jr.Total > 0 && offset >= jr.Total {
			break
		}
		// Safety brake: don't loop forever if total is missing / incorrect.
		if offset > 5000 {
			break
		}
	}

	return out, nil
}

func parseWorkdayPostedAt(s string) *time.Time {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	// Common formats seen: RFC3339, YYYY-MM-DD
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return &t
	}
	if t, err := time.Parse("2006-01-02", s); err == nil {
		return &t
	}
	// Sometimes it's epoch ms/seconds as a string.
	if n, err := strconv.ParseInt(s, 10, 64); err == nil {
		// Heuristic: treat >= 1e12 as ms, else seconds.
		var t time.Time
		if n >= 1_000_000_000_000 {
			t = time.UnixMilli(n)
		} else {
			t = time.Unix(n, 0)
		}
		return &t
	}
	return nil
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func truncate(s string, max int) string {
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.ReplaceAll(s, "\r", " ")
	s = strings.TrimSpace(s)
	if len(s) <= max {
		return s
	}
	return s[:max] + "..."
}
