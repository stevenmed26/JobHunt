package lever

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"jobhunt-engine/internal/domain"
)

type Config struct {
	Companies []Company
}

type Company struct {
	Slug string // api.lever.co/v0/postings/<slug>
	Name string
}

type Scraper struct {
	cfg Config
	hc  *http.Client
}

func New(cfg Config) *Scraper {
	return &Scraper{
		cfg: cfg,
		hc:  &http.Client{Timeout: 20 * time.Second},
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

func (s *Scraper) Fetch(ctx context.Context) ([]domain.JobLead, error) {
	var out []domain.JobLead
	for _, co := range s.cfg.Companies {
		jobs, err := s.fetchCompany(ctx, co)
		if err != nil {
			continue
		}
		out = append(out, jobs...)
	}
	return out, nil
}

func (s *Scraper) fetchCompany(ctx context.Context, co Company) ([]domain.JobLead, error) {
	apiURL := fmt.Sprintf("https://api.lever.co/v0/postings/%s?mode=json", co.Slug)

	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, apiURL, nil)
	req.Header.Set("User-Agent", "JobHunt/1.0 (+local)")
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
		loc := strings.TrimSpace(p.Categories.Location)
		mode := "Unknown"
		if strings.Contains(strings.ToLower(loc), "remote") {
			mode = "Remote"
		}

		out = append(out, domain.JobLead{
			CompanyName:     co.Name,
			Title:           strings.TrimSpace(p.Text),
			LocationRaw:     loc,
			WorkMode:        mode,
			URL:             p.HostedURL,
			PostedAt:        &t,
			Description:     p.Description,
			FirstSeenSource: "lever",
			ATSJobID:        fmt.Sprintf("lever:%s:%s", co.Slug, p.ID),
		})
	}
	return out, nil
}
