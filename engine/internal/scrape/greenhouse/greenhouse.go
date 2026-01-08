package greenhouse

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"jobhunt-engine/internal/domain"

	"github.com/PuerkitoBio/goquery"
)

type Config struct {
	Companies []Company // list of boards
}

type Company struct {
	Slug string // boards.greenhouse.io/<slug>
	Name string // display name
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

func (s *Scraper) Name() string { return "greenhouse" }

func (s *Scraper) Fetch(ctx context.Context) ([]domain.JobLead, error) {
	var out []domain.JobLead
	for _, co := range s.cfg.Companies {
		jobs, err := s.fetchCompany(ctx, co)
		if err != nil {
			// don’t fail the whole run because one board is down
			// log upstream; return partial results
			continue
		}
		out = append(out, jobs...)
	}
	return out, nil
}

func (s *Scraper) fetchCompany(ctx context.Context, co Company) ([]domain.JobLead, error) {
	boardURL := fmt.Sprintf("https://boards.greenhouse.io/%s", co.Slug)

	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, boardURL, nil)
	req.Header.Set("User-Agent", "JobHunt/1.0 (+local)")

	res, err := s.hc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("greenhouse get board: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode >= 400 {
		return nil, fmt.Errorf("greenhouse board status %d", res.StatusCode)
	}

	doc, err := goquery.NewDocumentFromReader(res.Body)
	if err != nil {
		return nil, fmt.Errorf("greenhouse parse board html: %w", err)
	}

	// Greenhouse boards usually have anchors to /<slug>/jobs/<id> or absolute /jobs/<id>
	seen := map[string]bool{}

	var jobs []domain.JobLead
	doc.Find("a[href]").Each(func(_ int, a *goquery.Selection) {
		href, ok := a.Attr("href")
		if !ok {
			return
		}
		href = strings.TrimSpace(href)
		if href == "" {
			return
		}

		abs := href
		if strings.HasPrefix(href, "/") {
			abs = "https://boards.greenhouse.io" + href
		}
		low := strings.ToLower(abs)
		if !strings.Contains(low, "boards.greenhouse.io") || !strings.Contains(low, "/jobs/") {
			return
		}

		jobID := extractJobID(abs)
		if jobID == "" {
			return
		}

		sourceID := fmt.Sprintf("greenhouse:%s:%s", co.Slug, jobID)
		if seen[sourceID] {
			return
		}
		seen[sourceID] = true

		title := cleanText(a.Text())
		if title == "" || looksLikeJunkTitle(title) {
			// we’ll still fetch details page to get the true title (some boards wrap titles weird)
			title = ""
		}

		jobs = append(jobs, domain.JobLead{
			CompanyName:     co.Name,
			Title:           title,
			URL:             abs,
			FirstSeenSource: "greenhouse",
			ATSJobID:        sourceID,
		})
	})

	// Hydrate details (title/location/desc/date) by fetching each job page
	for i := range jobs {
		_ = s.hydrateJob(ctx, &jobs[i])
		// ignore hydrate errors; keep minimal entry
	}

	return jobs, nil
}

func (s *Scraper) hydrateJob(ctx context.Context, j *domain.JobLead) error {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, j.URL, nil)
	req.Header.Set("User-Agent", "JobHunt/1.0 (+local)")
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

	// title
	if j.Title == "" {
		if t := cleanText(doc.Find("h1").First().Text()); t != "" {
			j.Title = t
		}
	}

	// location (Greenhouse often has .location or similar)
	loc := cleanText(doc.Find(".location").First().Text())
	if loc == "" {
		// fallback: search for "Location" labels
		loc = guessLocation(doc)
	}
	if loc != "" {
		j.LocationRaw = loc
	}

	// description HTML
	if sel := doc.Find("#content").First(); sel.Length() > 0 {
		if h, err := sel.Html(); err == nil {
			j.Description = h
		}
	}

	// date – many boards include meta or time tags; fallback to now
	if j.PostedAt == nil {
		t := time.Now()
		j.PostedAt = &t
	}

	// work mode heuristic
	if strings.Contains(strings.ToLower(j.LocationRaw), "remote") {
		j.WorkMode = "Remote"
	} else if j.WorkMode == "" {
		j.WorkMode = "Unknown"
	}
	return nil
}

func extractJobID(u string) string {
	// crude but effective: split on /jobs/ and take next chunk of digits
	parts := strings.Split(u, "/jobs/")
	if len(parts) < 2 {
		return ""
	}
	tail := parts[1]
	id := ""
	for _, r := range tail {
		if r >= '0' && r <= '9' {
			id += string(r)
		} else {
			break
		}
	}
	return id
}

func cleanText(s string) string {
	s = strings.ReplaceAll(s, "\u00a0", " ")
	s = strings.Join(strings.Fields(s), " ")
	return strings.TrimSpace(s)
}

func looksLikeJunkTitle(t string) bool {
	l := strings.ToLower(t)
	return strings.Contains(l, "view") || strings.Contains(l, "apply")
}

func guessLocation(doc *goquery.Document) string {
	// low-effort fallback; refine later
	return ""
}
