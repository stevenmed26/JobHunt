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

		// Logo: first img we can find in the card
		if j.LogoURL == "" {
			if img := card.Find("img").First(); img.Length() > 0 {
				if src, ok := img.Attr("src"); ok && strings.TrimSpace(src) != "" {
					j.LogoURL = strings.TrimSpace(src)
				} else if src, ok := img.Attr("data-src"); ok && strings.TrimSpace(src) != "" {
					j.LogoURL = strings.TrimSpace(src)
				}
			}
		}

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
	candidate = strings.TrimSpace(candidate)
	if candidate == "" {
		return false
	}
	// prefer a “real” title length
	cl := len(candidate)
	if cl < 4 || cl > 120 {
		return false
	}
	// prefer candidate if current empty
	if strings.TrimSpace(current) == "" {
		return true
	}
	// if current is very long (usually concatenated garbage) and candidate is shorter, take candidate
	if len(current) > 80 && cl < len(current) {
		return true
	}
	// otherwise keep current unless candidate looks more “title-like” (shorter is usually better)
	return cl < len(current)
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

func looksLikeLinkedInJobAlert(subj, body string) bool {
	s := strings.ToLower(subj)
	if strings.Contains(s, "job alert") || strings.Contains(s, "linkedin") {
		// body check prevents false positives
		b := strings.ToLower(body)
		return strings.Contains(b, "linkedin.com/comm/jobs/view") ||
			strings.Contains(b, "linkedin.com/jobs/view")
	}
	return false
}
