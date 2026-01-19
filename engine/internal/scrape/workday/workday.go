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
	"net/http/cookiejar"
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

	mu          sync.Mutex
	blockedHost map[string]bool
}

type board struct {
	Scheme string
	Host   string
	Tenant string
	Site   string
	Locale string
}

func New(cfg Config, limiter *util.HostLimiter) *Scraper {
	return &Scraper{
		cfg:         cfg,
		hc:          &http.Client{Timeout: 20 * time.Second},
		limiter:     limiter,
		blockedHost: map[string]bool{},
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

func newClient() *http.Client {
	jar, _ := cookiejar.New(nil)
	return &http.Client{
		Jar:     jar,
		Timeout: 30 * time.Second,
	}
}

var ErrWorkdayBlocked = errors.New("workday blocked by cloudflare")

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
				cctx, cancel := context.WithTimeout(ctx, 8*time.Second)
				jobs, err := s.fetchCompany(cctx, co)
				cancel()
				if err != nil {
					if errors.Is(err, ErrWorkdayBlocked) {
						log.Printf("[ats:workday] host blocked by Cloudflare; skipping remaining companies")
						continue
					}
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
		return board{}, errors.New("empty board url")
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
	if len(segs) == 0 || segs[0] == "" {
		return board{}, fmt.Errorf("unexpected path %q", u.Path)
	}

	// Detect locale like "en-US" (case-insensitive)
	locale := ""
	if len(segs) >= 2 && looksLikeLocale(segs[0]) {
		locale = normalizeLocale(segs[0]) // preserve proper casing
		// site becomes next segment
		segs = segs[1:]
	}

	site := segs[len(segs)-1]
	if site == "" {
		return board{}, fmt.Errorf("could not derive site from path %q", u.Path)
	}

	return board{
		Scheme: u.Scheme,
		Host:   u.Host,
		Tenant: tenant,
		Site:   site,
		Locale: locale,
	}, nil
}

func looksLikeLocale(s string) bool {
	// accepts en-US, en-us, etc.
	s = strings.TrimSpace(s)
	if len(s) != 5 || s[2] != '-' {
		return false
	}
	a := s[0:2]
	b := s[3:5]
	return isAlpha(a) && isAlpha(b)
}

func normalizeLocale(s string) string {
	s = strings.TrimSpace(s)
	if len(s) == 5 && s[2] == '-' {
		return strings.ToLower(s[0:2]) + "-" + strings.ToUpper(s[3:5])
	}
	return s
}

func isAlpha(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) {
			return false
		}
	}
	return true
}

func (b board) jobsEndpoint() string {
	base := fmt.Sprintf("%s://%s/wday/cxs/%s/%s/jobs", b.Scheme, b.Host, b.Tenant, b.Site)
	if b.Locale == "" {
		return base
	}
	// Workday accepts locale via query param on many tenants
	return base + "?locale=" + url.QueryEscape(b.Locale)
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

	s.mu.Lock()
	if s.blockedHost[b.Host] {
		s.mu.Unlock()
		return nil, ErrWorkdayBlocked
	}
	s.mu.Unlock()

	// Use a per-company client with a cookie jar so cookies/CSRF persist.
	hc := newClient()

	endpoint := b.jobsEndpoint()
	log.Printf("[ats:workday] company=%q endpoint=%q", co.Name, endpoint)

	// Bootstrap once; some tenants require CALYPSO_CSRF_TOKEN + CXS_SESSION.
	csrf, bootErr := bootstrapSession(ctx, hc, co.Slug)
	if errors.Is(bootErr, ErrWorkdayBlocked) {
		s.mu.Lock()
		s.blockedHost[b.Host] = true
		s.mu.Unlock()
		return nil, ErrWorkdayBlocked
	}

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

		req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
		if err != nil {
			return nil, err
		}

		origin := fmt.Sprintf("%s://%s", b.Scheme, b.Host)

		req.Header.Set("User-Agent", "Mozilla/5.0")
		req.Header.Set("Accept", "application/json")
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", origin)
		req.Header.Set("Referer", strings.TrimRight(co.Slug, "/"))

		lang := firstNonEmpty(b.Locale, "en-US")
		req.Header.Set("Accept-Language", lang)

		// If bootstrap succeeded, mirror browser behavior.
		if bootErr == nil && csrf != "" {
			req.Header.Set("x-calypso-csrf-token", csrf)
		}

		if s.limiter != nil {
			if err := s.limiter.WaitURL(ctx, endpoint); err != nil {
				return out, err
			}
		}

		res, err := hc.Do(req)
		if err != nil {
			return out, fmt.Errorf("workday post jobs: %w", err)
		}
		data, _ := io.ReadAll(res.Body)
		res.Body.Close()

		// Try one retry after bootstrapping.
		if res.StatusCode >= 400 {
			// If we already bootstrapped, don't loop.
			if bootErr == nil {
				return out, fmt.Errorf("workday status %d body=%s", res.StatusCode, truncate(string(data), 240))
			}

			// Try bootstrap + retry once
			csrf2, err2 := bootstrapSession(ctx, hc, co.Slug)
			if errors.Is(err2, ErrWorkdayBlocked) {
				s.mu.Lock()
				s.blockedHost[b.Host] = true
				s.mu.Unlock()
				return out, ErrWorkdayBlocked
			}
			bootErr = nil
			csrf = csrf2

			// retry request once with CSRF
			req2, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
			if err != nil {
				return nil, err
			}
			req2.Header.Set("User-Agent", "Mozilla/5.0")
			req2.Header.Set("Accept", "application/json")
			req2.Header.Set("Content-Type", "application/json")
			req2.Header.Set("Origin", origin)
			req2.Header.Set("Referer", strings.TrimRight(co.Slug, "/"))
			req2.Header.Set("Accept-Language", lang)
			req2.Header.Set("x-calypso-csrf-token", csrf)

			if s.limiter != nil {
				if err := s.limiter.WaitURL(ctx, endpoint); err != nil {
					return out, err
				}
			}

			res2, err := hc.Do(req2)
			if err != nil {
				return out, fmt.Errorf("workday retry post jobs: %w", err)
			}
			data2, _ := io.ReadAll(res2.Body)
			res2.Body.Close()

			if res2.StatusCode >= 400 {
				cfRay := res2.Header.Get("CF-RAY")
				server := res2.Header.Get("Server")
				return out, fmt.Errorf("workday status %d server=%q cfRay=%q body=%s",
					res2.StatusCode, server, cfRay, truncate(string(data), 240))
			}
			data = data2
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
		if offset > 5000 {
			break
		}
	}

	return out, nil
}

func bootstrapSession(ctx context.Context, client *http.Client, boardURL string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, boardURL, nil)
	if err != nil {
		return "", err
	}

	req.Header.Set("User-Agent", "Mozilla/5.0")
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
	req.Header.Set("Accept-Language", "en-US")

	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	// Read a small preview first (for CF detection), then discard the rest.
	previewBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	preview := string(previewBytes)
	io.Copy(io.Discard, resp.Body)

	if looksLikeCloudflareBlock(resp, preview) {
		return "", ErrWorkdayBlocked
	}

	// Pull CALYPSO_CSRF_TOKEN from cookies in jar
	u, _ := url.Parse(boardURL)
	for _, c := range client.Jar.Cookies(u) {
		if c.Name == "CALYPSO_CSRF_TOKEN" && c.Value != "" {
			return c.Value, nil
		}
	}

	return "", fmt.Errorf("workday bootstrap: missing CALYPSO_CSRF_TOKEN cookie (status=%d)", resp.StatusCode)
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

func looksLikeCloudflareBlock(resp *http.Response, bodyPreview string) bool {
	server := strings.ToLower(resp.Header.Get("Server"))
	cfRay := resp.Header.Get("CF-RAY")
	if cfRay == "" {
		cfRay = resp.Header.Get("cf-ray")
	}

	// If CF is in play at all, and we're not getting normal HTML, treat as blocked.
	if strings.Contains(server, "cloudflare") && cfRay != "" {
		return true
	}

	low := strings.ToLower(bodyPreview)
	if strings.Contains(low, "/cdn-cgi/") ||
		(strings.Contains(low, "cloudflare") && strings.Contains(low, "checking your browser")) ||
		(strings.Contains(low, "attention required") && strings.Contains(low, "cloudflare")) {
		return true
	}

	if resp.StatusCode == 403 || resp.StatusCode == 429 {
		return true
	}
	return false
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
