package email_scrape

import (
	"net/url"
	"regexp"
	"strings"

	"github.com/PuerkitoBio/goquery"
)

type LinkedInJob struct {
	Title    string
	Company  string
	Location string
	Salary   string
	URL      string
	LogoURL  string
	SourceID string // optional: parsed from /jobs/view/<id>
}

var reSalary = regexp.MustCompile(`\$\s?\d[\d,]*(?:K|M)?\s*(?:-\s*\$\s?\d[\d,]*(?:K|M)?)?\s*/\s*year`)
var reJobID = regexp.MustCompile(`/jobs/view/(\d+)`)

// ParseLinkedInJobAlertHTML merges multiple anchors pointing to the same job id.
// This avoids the “company_logo anchor seen first => title empty => dedupe kills the job” problem.
func ParseLinkedInJobAlertHTML(htmlBody string) ([]LinkedInJob, error) {
	doc, err := goquery.NewDocumentFromReader(strings.NewReader(htmlBody))
	if err != nil {
		return nil, err
	}

	byID := map[string]*LinkedInJob{} // key: linkedin:<jobid> or url fallback

	doc.Find("a[href]").Each(func(_ int, a *goquery.Selection) {
		href, _ := a.Attr("href")
		href = strings.TrimSpace(href)
		if href == "" {
			return
		}

		lh := strings.ToLower(href)
		if !(strings.Contains(lh, "/jobs/view/") || strings.Contains(lh, "/comm/jobs/view/")) {
			return
		}
		if !strings.Contains(lh, "linkedin.com") {
			return
		}

		jobURL := normalizeMaybeRedirectedURL(href)
		if jobURL == "" {
			return
		}

		sourceID := linkedInSourceID(jobURL)
		key := sourceID
		if key == "" {
			key = jobURL
		}

		j, ok := byID[key]
		if !ok {
			j = &LinkedInJob{
				URL:      jobURL,
				SourceID: sourceID,
			}
			byID[key] = j
		}

		// Candidate title: anchor text (often only present on job_posting/jobcard_body anchors)
		titleCand := cleanText(a.Text())
		titleCand = stripBadTitleSuffixes(titleCand)
		if betterTitle(titleCand, j.Title) {
			j.Title = titleCand
		}

		// Grab surrounding card container
		card := a.Closest("table")
		if card.Length() == 0 {
			card = a.Closest("tr")
		}
		if card.Length() == 0 {
			card = a.Parent()
		}

		// Company · Location is usually in a <p>
		card.Find("p").Each(func(_ int, p *goquery.Selection) {
			t := cleanText(p.Text())
			if t == "" {
				return
			}

			// Company · Location
			if j.Company == "" && j.Location == "" && strings.Contains(t, " · ") {
				parts := strings.SplitN(t, " · ", 2)
				j.Company = strings.TrimSpace(parts[0])
				j.Location = strings.TrimSpace(parts[1])
			}

			// Sometimes title is also in <p> (depends on template)
			t2 := stripBadTitleSuffixes(t)
			if betterTitle(t2, j.Title) && !strings.Contains(t2, " · ") {
				j.Title = t2
			}
		})

		// Salary (optional)
		if j.Salary == "" {
			if blob := cleanText(card.Text()); blob != "" {
				if m := reSalary.FindString(blob); m != "" {
					j.Salary = strings.TrimSpace(m)
				}
			}
		}
	})

	// Emit only valid jobs (must have URL + Title)
	out := make([]LinkedInJob, 0, len(byID))
	for _, j := range byID {
		if strings.TrimSpace(j.URL) == "" {
			continue
		}
		if strings.TrimSpace(j.Title) == "" {
			continue
		}
		out = append(out, *j)
	}

	return out, nil
}

func linkedInSourceID(jobURL string) string {
	if m := reJobID.FindStringSubmatch(jobURL); len(m) == 2 {
		return "linkedin:" + m[1]
	}
	return ""
}

func normalizeMaybeRedirectedURL(href string) string {
	u, err := url.Parse(href)
	if err != nil {
		return ""
	}

	// wrapper with url= param
	if raw := u.Query().Get("url"); raw != "" {
		if uu, err := url.Parse(raw); err == nil && uu.Host != "" {
			return uu.String()
		}
	}

	// google redirect /url?q=
	if strings.Contains(strings.ToLower(u.Host), "google.") && strings.HasPrefix(u.Path, "/url") {
		if q := u.Query().Get("q"); q != "" {
			if uu, err := url.Parse(q); err == nil && uu.Host != "" {
				return uu.String()
			}
		}
	}

	// already absolute
	if u.Host != "" {
		return u.String()
	}

	return href
}

func cleanText(s string) string {
	s = strings.ReplaceAll(s, "\u00a0", " ")
	s = strings.Join(strings.Fields(s), " ")
	return s
}

func stripBadTitleSuffixes(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	// common LinkedIn email junk that gets appended
	bads := []string{
		"Actively recruiting",
		"Easy Apply",
		"Promoted",
	}
	for _, b := range bads {
		s = strings.TrimSpace(strings.ReplaceAll(s, b, ""))
	}
	// avoid obvious non-titles
	low := strings.ToLower(s)
	if strings.Contains(low, "alumni") ||
		strings.Contains(low, "connections") ||
		strings.Contains(low, "applicants") ||
		strings.Contains(low, "school") {
		return ""
	}
	return strings.Join(strings.Fields(s), " ")
}

func betterTitle(candidate, current string) bool {
	c := strings.TrimSpace(candidate)
	if c == "" {
		return false
	}
	cur := strings.TrimSpace(current)

	// If current empty, accept any plausible title-like string
	if cur == "" {
		return titleScore(c) >= 5
	}

	cs := titleScore(c)
	ks := titleScore(cur)

	if titleScore(current) >= 8 && titleScore(candidate) < titleScore(current) {
		return false
	}

	// Only replace if candidate is meaningfully better (avoid flip-flopping)
	return cs >= ks+3
}

func extractLinkedInTitle(a, container *goquery.Selection) string {
	// 1) Bold/strong text within the anchor (often title)
	if t := cleanText(a.Find("strong,b").First().Text()); t != "" {
		return t
	}

	// 2) First <p> inside the anchor that isn't "Company · Location" and isn't salary/badges
	a.Find("p").EachWithBreak(func(_ int, p *goquery.Selection) bool {
		txt := cleanText(p.Text())
		if txt == "" {
			return true
		}
		l := strings.ToLower(txt)
		if strings.Contains(txt, " · ") {
			return true
		}
		if reSalary.MatchString(txt) {
			return true
		}
		if strings.Contains(l, "actively recruiting") || strings.Contains(l, "easy apply") {
			return true
		}
		// return this p as title
		// (we have to store and break via closure trick)
		container.SetAttr("_title_candidate", txt)
		return false
	})
	if v, ok := container.Attr("_title_candidate"); ok && strings.TrimSpace(v) != "" {
		container.RemoveAttr("_title_candidate")
		return strings.TrimSpace(v)
	}

	// 3) As a fallback, look for any <p> in the container (near the link) that isn't company/location
	container.Find("p").EachWithBreak(func(_ int, p *goquery.Selection) bool {
		txt := cleanText(p.Text())
		if txt == "" {
			return true
		}
		if strings.Contains(txt, " · ") {
			return true
		}
		if reSalary.MatchString(txt) {
			return true
		}
		l := strings.ToLower(txt)
		if strings.Contains(l, "actively recruiting") || strings.Contains(l, "easy apply") {
			return true
		}
		container.SetAttr("_title_candidate2", txt)
		return false
	})
	if v, ok := container.Attr("_title_candidate2"); ok && strings.TrimSpace(v) != "" {
		container.RemoveAttr("_title_candidate2")
		return strings.TrimSpace(v)
	}

	return ""
}

func normalizeURL(href string) string {
	u, err := url.Parse(href)
	if err != nil {
		return ""
	}
	// Handle redirect wrappers that include ?url=
	if raw := u.Query().Get("url"); raw != "" {
		if uu, err := url.Parse(raw); err == nil && uu.Host != "" {
			return uu.String()
		}
	}
	if u.Host != "" {
		return u.String()
	}
	return href
}

func looksLikeLinkedInJobURL(href string) bool {
	h := strings.ToLower(href)
	// Handles common tracking/redirect wrappers too because the final URL is often included directly.
	return strings.Contains(h, "linkedin.com") &&
		(strings.Contains(h, "/jobs/view") || strings.Contains(h, "/comm/jobs/view"))
}

func looksLikeLinkedInJobAlert(from, subj, body string) bool {
	f := strings.ToLower(from)
	if strings.Contains(f, "jobalerts-noreply") {
		return true
	}
	s := strings.ToLower(subj)
	if strings.Contains(s, "job alert") || strings.Contains(s, "linkedin") {
		// body check prevents false positives
		b := strings.ToLower(body)
		return strings.Contains(b, "linkedin.com/comm/jobs/view") ||
			strings.Contains(b, "linkedin.com/jobs/view")
	}
	return false
}

func titleScore(s string) int {
	orig := strings.TrimSpace(s)
	if orig == "" {
		return -100
	}

	l := strings.ToLower(orig)
	score := 0

	// Hard rejects / strong negatives
	if strings.Contains(l, "unsubscribe") || strings.Contains(l, "manage") && strings.Contains(l, "alert") {
		return -50
	}
	if strings.Contains(l, "http://") || strings.Contains(l, "https://") || strings.Contains(l, "www.") {
		return -30
	}

	// Salary-ish
	if strings.ContainsAny(orig, "$€£") {
		score -= 8
	}
	if strings.Contains(l, "per hour") || strings.Contains(l, "/hour") || strings.Contains(l, "/hr") ||
		strings.Contains(l, "per year") || strings.Contains(l, "/year") || strings.Contains(l, "/yr") {
		score -= 6
	}
	// quick range-ish heuristic without regex
	if strings.Count(orig, "-") >= 1 && (strings.ContainsAny(orig, "$€£") || strings.Contains(l, "k")) {
		score -= 4
	}

	// CTA-ish
	for _, bad := range []string{"apply", "view job", "see job", "see details", "learn more", "sign in"} {
		if strings.Contains(l, bad) {
			score -= 6
		}
	}

	// Location-ish
	for _, loc := range []string{"remote", "hybrid", "on-site", "onsite", "united states", "usa"} {
		if strings.Contains(l, loc) {
			score -= 3
		}
	}

	// Separator soup often means concatenated row data
	if strings.Count(orig, "|") >= 1 || strings.Count(orig, "•") >= 1 {
		score -= 2
	}

	// Title keywords (positive)
	titleWords := []string{
		"engineer", "developer", "software", "backend", "frontend", "full stack", "full-stack",
		"platform", "cloud", "devops", "sre", "security", "embedded", "firmware",
		"data", "ml", "ai", "scientist", "analyst", "architect",
		"manager", "director", "lead", "principal", "staff", "intern", "technician",
	}
	for _, w := range titleWords {
		if strings.Contains(l, w) {
			score += 4
			break
		}
	}

	// Seniority tokens
	for _, w := range []string{"sr", "senior", "jr", "junior", "i", "ii", "iii", "iv", "principal", "staff", "lead"} {
		if containsWord(l, w) {
			score += 2
		}
	}

	// Shape heuristics
	n := len([]rune(orig))
	if n >= 6 && n <= 80 {
		score += 2
	} else if n < 4 || n > 140 {
		score -= 6
	}

	// Looks like a sentence / description
	if strings.HasSuffix(orig, ".") || strings.Contains(l, "you will") || strings.Contains(l, "we are") {
		score -= 4
	}

	// Too many digits is suspicious (ids/salary)
	digits := 0
	for _, r := range orig {
		if r >= '0' && r <= '9' {
			digits++
		}
	}
	if digits >= 6 {
		score -= 4
	}

	return score
}

// containsWord checks for whole-word-ish match in a cheap way.
// This avoids "sr" matching "sre" incorrectly, etc.
func containsWord(haystackLower, needleLower string) bool {
	// boundary set: space and common punctuation seen in titles
	bounds := func(r rune) bool {
		switch r {
		case ' ', '\t', '\n', '\r', '-', '—', '–', '/', '\\', '(', ')', '[', ']', '{', '}', ',', '.', ':', ';', '|', '•':
			return true
		default:
			return false
		}
	}

	// scan for needle and check boundaries
	idx := strings.Index(haystackLower, needleLower)
	for idx != -1 {
		leftOK := idx == 0 || bounds(rune(haystackLower[idx-1]))
		rightIdx := idx + len(needleLower)
		rightOK := rightIdx == len(haystackLower) || bounds(rune(haystackLower[rightIdx]))
		if leftOK && rightOK {
			return true
		}
		next := strings.Index(haystackLower[idx+1:], needleLower)
		if next == -1 {
			break
		}
		idx = idx + 1 + next
	}
	return false
}
