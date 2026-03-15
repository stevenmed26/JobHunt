package httpapi

import (
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode"
)

// CompanySearchHandler probes Greenhouse and Lever to check whether a company
// has a job board, then returns confirmed slug + name pairs.
type CompanySearchHandler struct{}

type companyResult struct {
	Name   string `json:"name"`
	Slug   string `json:"slug"`
	ATS    string `json:"ats"`    // "greenhouse" | "lever"
	JobURL string `json:"jobUrl"` // link to the live board for verification
}

var httpClient = &http.Client{Timeout: 8 * time.Second}

// Search handles GET /api/companies/search?q=stripe&ats=greenhouse
// Returns a list of confirmed ATS boards matching the query.
func (h CompanySearchHandler) Search(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	ats := strings.TrimSpace(r.URL.Query().Get("ats")) // "greenhouse" | "lever" | "" (both)

	if len(q) < 2 {
		writeJSON(w, map[string]any{"results": []companyResult{}})
		return
	}

	slugCandidates := generateSlugs(q)

	var (
		mu      sync.Mutex
		results []companyResult
		wg      sync.WaitGroup
	)

	for _, slug := range slugCandidates {
		slug := slug

		if ats == "" || ats == "greenhouse" {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if name, ok := probeGreenhouse(slug); ok {
					mu.Lock()
					results = append(results, companyResult{
						Name:   name,
						Slug:   slug,
						ATS:    "greenhouse",
						JobURL: fmt.Sprintf("https://boards.greenhouse.io/%s", slug),
					})
					mu.Unlock()
				}
			}()
		}

		if ats == "" || ats == "lever" {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if name, ok := probeLever(slug); ok {
					mu.Lock()
					results = append(results, companyResult{
						Name:   name,
						Slug:   slug,
						ATS:    "lever",
						JobURL: fmt.Sprintf("https://jobs.lever.co/%s", slug),
					})
					mu.Unlock()
				}
			}()
		}
	}

	wg.Wait()

	// Deduplicate by ats+slug
	seen := map[string]bool{}
	deduped := results[:0]
	for _, r := range results {
		key := r.ATS + ":" + r.Slug
		if !seen[key] {
			seen[key] = true
			deduped = append(deduped, r)
		}
	}

	writeJSON(w, map[string]any{"results": deduped})
}

// generateSlugs produces candidate slugs from a company name query.
// Tries several normalisation strategies that match how companies register.
func generateSlugs(q string) []string {
	seen := map[string]bool{}
	add := func(s string) {
		s = strings.TrimSpace(s)
		if s != "" && !seen[s] {
			seen[s] = true
		}
	}

	// Normalise: lowercase, remove punctuation except hyphen
	lower := strings.ToLower(q)
	noPunct := strings.Map(func(r rune) rune {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == ' ' || r == '-' {
			return r
		}
		return -1
	}, lower)

	// Strategy 1: spaces → nothing (e.g. "stripe" → "stripe")
	add(strings.ReplaceAll(noPunct, " ", ""))

	// Strategy 2: spaces → hyphen (e.g. "scale ai" → "scale-ai")
	add(strings.ReplaceAll(noPunct, " ", "-"))

	// Strategy 3: remove common suffixes then apply above
	stopWords := []string{" inc", " inc.", " corp", " corp.", " llc", " ltd", " limited",
		" co", " co.", " company", " technologies", " technology", " solutions",
		" group", " labs", " ai", " io"}
	stripped := lower
	for _, sw := range stopWords {
		stripped = strings.TrimSuffix(stripped, sw)
	}
	stripped = strings.Map(func(r rune) rune {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == ' ' || r == '-' {
			return r
		}
		return -1
	}, stripped)
	add(strings.ReplaceAll(stripped, " ", ""))
	add(strings.ReplaceAll(stripped, " ", "-"))

	// Strategy 4: first word only (many companies use just their brand name)
	words := strings.Fields(noPunct)
	if len(words) > 1 {
		add(words[0])
	}

	// Strategy 5: acronym for multi-word names (e.g. "International Business Machines" → "ibm")
	if len(words) >= 3 {
		acronym := ""
		for _, w := range words {
			if len(w) > 0 {
				acronym += string(w[0])
			}
		}
		add(acronym)
	}

	result := make([]string, 0, len(seen))
	for s := range seen {
		// Basic sanity: only allow slug-safe characters
		if regexp.MustCompile(`^[a-z0-9][a-z0-9\-]{0,49}$`).MatchString(s) {
			result = append(result, s)
		}
	}
	return result
}

// probeGreenhouse checks whether a Greenhouse board exists for the slug.
// Returns the company name from the board metadata on success.
func probeGreenhouse(slug string) (name string, ok bool) {
	apiURL := fmt.Sprintf("https://boards-api.greenhouse.io/v1/boards/%s", url.PathEscape(slug))
	resp, err := httpClient.Get(apiURL)
	if err != nil || resp.StatusCode != 200 {
		if resp != nil {
			resp.Body.Close()
		}
		return "", false
	}
	defer resp.Body.Close()

	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return "", false
	}
	if strings.TrimSpace(body.Name) == "" {
		return slug, true
	}
	return body.Name, true
}

// probeLever checks whether a Lever board exists for the slug.
// Returns the company name inferred from the first posting on success.
func probeLever(slug string) (name string, ok bool) {
	apiURL := fmt.Sprintf("https://api.lever.co/v0/postings/%s?mode=json&limit=1", url.PathEscape(slug))
	resp, err := httpClient.Get(apiURL)
	if err != nil || resp.StatusCode != 200 {
		if resp != nil {
			resp.Body.Close()
		}
		return "", false
	}
	defer resp.Body.Close()

	var postings []struct {
		Text string `json:"text"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&postings); err != nil {
		return "", false
	}
	// Lever returns an empty array for unknown slugs with 200 — treat as not found
	if len(postings) == 0 {
		return "", false
	}

	// Use the slug title-cased as the name (Lever API doesn't expose company name directly)
	parts := strings.Split(slug, "-")
	for i, p := range parts {
		if len(p) > 0 {
			parts[i] = strings.ToUpper(p[:1]) + p[1:]
		}
	}
	return strings.Join(parts, " "), true
}

// CompanyDiscoveryHandler discovers ATS companies through several passive sources:
//   - Lever's public sitemap (lists every active company slug)
//   - Greenhouse board discovery by fetching known job aggregator pages
//   - URL extraction from arbitrary text (paste a job listing email, etc.)
type CompanyDiscoveryHandler struct{}

// ─── GET /api/companies/discover?source=lever|greenhouse|url&q=... ────────────

func (h CompanyDiscoveryHandler) Discover(w http.ResponseWriter, r *http.Request) {
	source := strings.TrimSpace(r.URL.Query().Get("source"))
	q := strings.TrimSpace(r.URL.Query().Get("q")) // used for keyword filter

	switch source {
	case "lever":
		h.discoverLever(w, q)
	case "greenhouse":
		h.discoverGreenhouse(w, q)
	default:
		http.Error(w, "source must be lever or greenhouse", http.StatusBadRequest)
	}
}

// ─── POST /api/companies/extract ─────────────────────────────────────────────
// Accepts raw text (job emails, HTML, anything) and extracts ATS slugs from URLs.

func (h CompanyDiscoveryHandler) Extract(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20)) // 1MB max
	if err != nil {
		http.Error(w, "failed to read body", http.StatusBadRequest)
		return
	}
	text := string(body)
	results := extractATSSlugsFromText(text)
	writeJSON(w, map[string]any{"results": results})
}

// ─── Lever sitemap ────────────────────────────────────────────────────────────

type sitemapURLSet struct {
	URLs []sitemapURL `xml:"url"`
}
type sitemapURL struct {
	Loc string `xml:"loc"`
}

func (h CompanyDiscoveryHandler) discoverLever(w http.ResponseWriter, keyword string) {
	client := &http.Client{Timeout: 20 * time.Second}

	resp, err := client.Get("https://jobs.lever.co/sitemap.xml")
	if err != nil {
		http.Error(w, "failed to fetch Lever sitemap: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		http.Error(w, fmt.Sprintf("Lever sitemap returned %d", resp.StatusCode), http.StatusBadGateway)
		return
	}

	var sitemap sitemapURLSet
	if err := xml.NewDecoder(resp.Body).Decode(&sitemap); err != nil {
		http.Error(w, "failed to parse sitemap: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Extract unique slugs from URLs like https://jobs.lever.co/{slug}/{id}
	slugRe := regexp.MustCompile(`https://jobs\.lever\.co/([^/]+)/`)
	seen := map[string]bool{}
	var results []companyResult

	kwLower := strings.ToLower(keyword)

	for _, u := range sitemap.URLs {
		m := slugRe.FindStringSubmatch(u.Loc)
		if len(m) < 2 {
			continue
		}
		slug := m[1]
		if seen[slug] {
			continue
		}
		seen[slug] = true

		// Build display name from slug
		name := slugToName(slug)

		// Apply keyword filter if provided
		if kwLower != "" &&
			!strings.Contains(strings.ToLower(slug), kwLower) &&
			!strings.Contains(strings.ToLower(name), kwLower) {
			continue
		}

		results = append(results, companyResult{
			Name:   name,
			Slug:   slug,
			ATS:    "lever",
			JobURL: fmt.Sprintf("https://jobs.lever.co/%s", slug),
		})

		// Cap at 200 results per request
		if len(results) >= 200 {
			break
		}
	}

	writeJSON(w, map[string]any{
		"results": results,
		"total":   len(seen),
	})
}

// ─── Greenhouse discovery ─────────────────────────────────────────────────────
// Greenhouse has no public sitemap. Instead we use two strategies:
//   1. Check a curated seed list of ~300 well-known tech companies in parallel
//   2. Probe slug variations from the keyword query

func (h CompanyDiscoveryHandler) discoverGreenhouse(w http.ResponseWriter, keyword string) {
	// Seed list — well-known tech companies likely on Greenhouse
	// Expanded from the user's existing companies.yml
	seeds := []string{
		"stripe", "airbnb", "asana", "datadog", "mongodb", "hashicorp", "twilio",
		"snowflakecomputing", "confluentinc", "databricks", "okta", "shopify",
		"doordash", "lyft", "coinbase", "robinhood", "dropbox", "pinterest", "reddit",
		"gitlab", "squareup", "zoom", "microsoft", "servicenow", "workday", "zendesk",
		"hubspot", "atlassian", "figma", "notion", "linear", "samsara", "brex", "ramp",
		"chime", "checkr", "gusto", "instacart", "twitch", "netflix", "peloton", "canva",
		"khanacademy", "duolingo", "coursera", "zapier", "docusign", "newrelic", "sentry",
		"fastly", "elastic", "splunk", "akamai", "palantir", "anduril", "scaleai",
		"openai", "anthropic", "mistral", "cohere", "huggingface", "together", "deepmind",
		"cloudflare", "vercel", "netlify", "grafana", "circleci", "github", "gitkraken",
		"snyk", "dataminr", "hackerone", "postman", "segment", "algolia", "docker",
		"launchdarkly", "harness", "cockroachlabs", "neo4j", "temporal", "pulumi",
		"influxdata", "timescale", "airbyte", "fivetran", "dbt-labs", "benchling",
		"calendly", "intercom", "mixpanel", "braze", "attentive", "sendgrid", "twilio",
		"plaid", "mercury", "rippling", "deel", "pagerduty", "smartsheet", "sprout",
		"webflow", "retool", "airtable", "notion", "clickup", "monday", "asana",
		"rubrik", "cohesity", "druva", "commvault", "veeam", "zerto", "veritas",
		"crowdstrike", "sentinelone", "palo-alto", "fortinet", "qualys", "tenable",
		"lacework", "orca", "wiz", "snyk", "checkmarx", "veracode", "sonarqube",
		"hashicorp", "puppet", "chef", "ansible", "saltstack", "cloudbees",
		"unity3d", "epicgames", "riotgames", "activision", "ea", "ubisoft",
		"spacex", "palantir", "anduril", "shield-ai", "rebellion", "hermeus",
		"jobyaviation", "archer", "wisk", "lilium", "zipline", "skydio",
		"stripe", "square", "adyen", "checkout", "recurly", "chargebee", "paddle",
		"toast", "lightspeed", "shopify", "bigcommerce", "woocommerce",
		"okta", "auth0", "onelogin", "jumpcloud", "sailpoint", "cyberark",
		"workiva", "anaplan", "planful", "mosaic", "pigment", "cube",
		"medallia", "qualtrics", "sprinklr", "hootsuite", "buffer", "brandwatch",
		"zendesk", "freshworks", "intercom", "helpscout", "gladly", "kustomer",
		"slack", "miro", "mural", "lucid", "figma", "invision", "zeplin",
		"greenhouse", "lever", "workday", "successfactors", "bamboohr", "rippling",
		"lattice", "culture-amp", "glint", "leapsome", "15five", "betterworks",
		"gusto", "rippling", "justworks", "trinet", "adp", "paychex",
		"gotorq", "onbe", "credera", "cloudflare", "crunchyroll", "qualtrics",
		"oscar", "onemedical", "modernhealth", "betterup", "headspace", "calm",
		"noom", "hims", "ro", "cerebral", "livongo", "teladoc", "amwell",
		"waymo", "cruise", "argo", "aurora", "motional", "pony", "zoox",
		"rivian", "lucid", "nuro", "gatik", "kodiak", "torc",
		"faire", "glamcorner", "thredup", "poshmark", "depop", "vinted",
		"klarna", "affirm", "afterpay", "zip", "sezzle", "perpay",
	}

	kwLower := strings.ToLower(keyword)

	// Filter seeds by keyword if provided, otherwise probe all
	var toProbe []string
	if kwLower != "" {
		for _, s := range seeds {
			if strings.Contains(s, kwLower) {
				toProbe = append(toProbe, s)
			}
		}
		// Also generate slug candidates from the keyword itself
		toProbe = append(toProbe, generateSlugs(keyword)...)
	} else {
		toProbe = seeds
	}

	var (
		mu      sync.Mutex
		results []companyResult
		wg      sync.WaitGroup
		sem     = make(chan struct{}, 20) // 20 concurrent probes
	)

	for _, slug := range toProbe {
		slug := slug
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			if name, ok := probeGreenhouse(slug); ok {
				mu.Lock()
				results = append(results, companyResult{
					Name:   name,
					Slug:   slug,
					ATS:    "greenhouse",
					JobURL: fmt.Sprintf("https://boards.greenhouse.io/%s", slug),
				})
				mu.Unlock()
			}
		}()
	}
	wg.Wait()

	writeJSON(w, map[string]any{
		"results": results,
		"total":   len(toProbe),
	})
}

// ─── URL extraction from pasted text ─────────────────────────────────────────

var (
	ghURLRe    = regexp.MustCompile(`boards(?:-api)?\.greenhouse\.io/([a-zA-Z0-9_\-]+)`)
	leverURLRe = regexp.MustCompile(`jobs\.lever\.co/([a-zA-Z0-9_\-]+)`)
	jobBoardGH = regexp.MustCompile(`job-boards\.greenhouse\.io/([a-zA-Z0-9_\-]+)`)
)

func extractATSSlugsFromText(text string) []companyResult {
	seen := map[string]bool{}
	var out []companyResult

	addResult := func(slug, ats, urlTemplate string) {
		key := ats + ":" + slug
		if seen[key] || slug == "" {
			return
		}
		// Skip obvious non-slugs
		if slug == "v1" || slug == "boards" || slug == "jobs" || slug == "embed" {
			return
		}
		seen[key] = true
		out = append(out, companyResult{
			Name:   slugToName(slug),
			Slug:   slug,
			ATS:    ats,
			JobURL: fmt.Sprintf(urlTemplate, slug),
		})
	}

	for _, m := range ghURLRe.FindAllStringSubmatch(text, -1) {
		addResult(m[1], "greenhouse", "https://boards.greenhouse.io/%s")
	}
	for _, m := range jobBoardGH.FindAllStringSubmatch(text, -1) {
		addResult(m[1], "greenhouse", "https://boards.greenhouse.io/%s")
	}
	for _, m := range leverURLRe.FindAllStringSubmatch(text, -1) {
		addResult(m[1], "lever", "https://jobs.lever.co/%s")
	}

	return out
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// slugToName converts a slug like "scale-ai" → "Scale Ai"
// Good enough for display; Greenhouse's API returns the real name when probed.
func slugToName(slug string) string {
	parts := strings.FieldsFunc(slug, func(r rune) bool {
		return r == '-' || r == '_'
	})
	for i, p := range parts {
		if len(p) > 0 {
			parts[i] = strings.ToUpper(p[:1]) + p[1:]
		}
	}
	return strings.Join(parts, " ")
}
