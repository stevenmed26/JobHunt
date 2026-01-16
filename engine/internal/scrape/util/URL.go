package util

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

func urlIsTooGeneric(u string) bool {
	lu := strings.ToLower(u)

	if strings.Contains(lu, "linkedin.com/comm/jobs/alerts") {
		return true
	}

	return false
}
