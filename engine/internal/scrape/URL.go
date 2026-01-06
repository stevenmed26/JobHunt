package scrape

import (
	"net/url"
	"sort"
	"strings"
)

func canonicalizeURL(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}

	u.Scheme = strings.ToLower(u.Scheme)
	u.Host = strings.ToLower(u.Host)
	u.Fragment = ""

	// drop common tracking params
	q := u.Query()
	for k := range q {
		lk := strings.ToLower(k)
		if strings.HasPrefix(lk, "utm_") ||
			lk == "gclid" || lk == "fbclid" || lk == "msclkid" ||
			lk == "mc_cid" || lk == "mc_eid" ||
			lk == "mkt_tok" {
			q.Del(k)
		}
	}

	// keep only useful linkedin param currentJobId if present
	if strings.Contains(u.Host, "linkedin.com") {
		keep := url.Values{}
		if v := q.Get("currentJobId"); v != "" {
			keep.Set("currentJobId", v)
		}
		q = keep
	}

	// deterministic query
	for k := range q {
		vals := q[k]
		sort.Strings(vals)
		q[k] = vals
	}
	u.RawQuery = q.Encode()
	return u.String()
}

func scoreURL(u string) int {
	lu := strings.ToLower(u)
	score := 0

	// prefer obvious job pages
	if strings.Contains(lu, "/jobs/view/") {
		score += 100
	}
	if strings.Contains(lu, "greenhouse.io") || strings.Contains(lu, "lever.co") || strings.Contains(lu, "myworkdayjobs") {
		score += 80
	}
	if strings.Contains(lu, "/apply") || strings.Contains(lu, "apply") {
		score += 40
	}
	if strings.Contains(lu, "/job") || strings.Contains(lu, "/jobs") || strings.Contains(lu, "/careers") {
		score += 20
	}

	// penalize likely junk
	if strings.Contains(lu, "/alerts") || strings.Contains(lu, "/settings") {
		score -= 100
	}
	if strings.Contains(lu, "linkedin.com/comm/") {
		score -= 10
	}

	return score
}

func isObviousJunkURL(u string) bool {
	lu := strings.ToLower(u)

	// hard junk / template links
	junks := []string{
		"unsubscribe",
		"preferences",
		"manage-preferences",
		"email-preferences",
		"privacy",
		"terms",
		"view-in-browser",
		"viewaswebpage",
		"tracking",
		"pixel",
		"beacon",
		"/alerts",
		"/settings",
		"/help",
		"/legal",
	}
	for _, j := range junks {
		if strings.Contains(lu, j) {
			return true
		}
	}
	return false
}
