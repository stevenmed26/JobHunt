package lever

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"jobhunt-engine/internal/domain"
	"jobhunt-engine/internal/scrape/types"
	"jobhunt-engine/internal/scrape/util"

	"github.com/PuerkitoBio/goquery"
)

type Config struct {
	Companies []Company
}

type Company struct {
	Slug string // api.lever.co/v0/postings/<slug>
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
		hc:      &http.Client{Timeout: 20 * time.Second},
		limiter: limiter,
	}
}

func (s *Scraper) Name() string { return "lever" }

type leverPosting struct {
	ID         string `json:"id"`
	Text       string `json:"text"` // title
	HostedURL  string `json:"hostedUrl"`
	CreatedAt  int64  `json:"createdAt"` // ms epoch
	Categories struct {
		Location string `json:"location"`
		Team     string `json:"team"`
	} `json:"categories"`
	Description string `json:"description"` // html
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
				cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
				jobs, err := s.fetchCompany(cctx, co)
				cancel()

				if err != nil {
					log.Printf("[ats:lever] company=%q slug=%q err=%v", co.Name, co.Slug, err)
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

	log.Printf("[lever] Processed: %d", len(out))
	return types.ScrapeResult{
		Source: "lever",
		Leads:  out,
	}, nil
}

func (s *Scraper) fetchCompany(ctx context.Context, co Company) ([]domain.JobLead, error) {
	apiURL := fmt.Sprintf("https://api.lever.co/v0/postings/%s?mode=json", co.Slug)

	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, apiURL, nil)
	req.Header.Set("User-Agent", "JobHunt/1.0 (+local)")

	if s.limiter != nil {
		if err := s.limiter.WaitURL(ctx, apiURL); err != nil {
			return nil, err
		}
	}
	res, err := s.hc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("lever get: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode >= 400 {
		return nil, fmt.Errorf("lever status %d", res.StatusCode)
	}

	var postings []leverPosting
	if err := json.NewDecoder(res.Body).Decode(&postings); err != nil {
		return nil, fmt.Errorf("lever decode: %w", err)
	}

	out := make([]domain.JobLead, 0, len(postings))
	for _, p := range postings {
		if p.ID == "" || p.HostedURL == "" || strings.TrimSpace(p.Text) == "" {
			continue
		}
		t := time.Now()
		if p.CreatedAt > 0 {
			t = time.UnixMilli(p.CreatedAt)
		}
		loc := util.NormalizeLocation(p.Categories.Location)
		mode := util.InferWorkModeFromText(loc, p.Text, p.Description)

		out = append(out, domain.JobLead{
			CompanyName:     co.Name,
			Title:           strings.TrimSpace(p.Text),
			LocationRaw:     loc,
			WorkMode:        mode,
			URL:             p.HostedURL,
			PostedAt:        &t,
			Description:     p.Description,
			FirstSeenSource: "Lever",
			ATSJobID:        fmt.Sprintf("lever:%s:%s", co.Slug, p.ID),
		})

	}
	for i := range out {
		if out[i].LocationRaw == "" || out[i].WorkMode == "Unknown" {
			_ = s.hydrateJob(ctx, &out[i])
		}
	}

	return out, nil
}

func (s *Scraper) hydrateJob(ctx context.Context, j *domain.JobLead) error {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, j.URL, nil)
	req.Header.Set("User-Agent", "JobHunt/1.0 (+local)")

	if s.limiter != nil {
		if err := s.limiter.WaitURL(ctx, j.URL); err != nil {
			return err
		}
	}

	res, err := s.hc.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 400 {
		return fmt.Errorf("job page status %d", res.StatusCode)
	}

	doc, err := goquery.NewDocumentFromReader(res.Body)
	if err != nil {
		return err
	}

	// title fallback
	if j.Title == "" {
		if t := util.CleanText(doc.Find("h1").First().Text()); t != "" {
			j.Title = t
		}
	}

	// location fallback (try a few lever-ish patterns)
	if j.LocationRaw == "" {
		candidates := []string{
			"[itemprop='jobLocation']",
			"[data-qa='location']",
			".location",
			".posting-categories .location",
			".posting-categories li",
		}
		for _, sel := range candidates {
			if t := util.CleanText(doc.Find(sel).First().Text()); t != "" {
				j.LocationRaw = util.NormalizeLocation(t)
				break
			}
		}
	}

	if j.WorkMode == "" || j.WorkMode == "Unknown" {
		j.WorkMode = util.InferWorkModeFromText(j.LocationRaw, j.Title, j.Description)
	}
	if j.WorkMode == "" {
		j.WorkMode = "Unknown"
	}

	return nil
}
