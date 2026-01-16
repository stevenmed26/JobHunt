package scrape

import (
	"context"
	"database/sql"
	"fmt"
	"jobhunt-engine/internal/store"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/PuerkitoBio/goquery"
)

var domainBlocklist = []string{
	"linkedin.com",
	"indeed.com",
	"glassdoor.com",
	"ziprecruiter.com",
	"monster.com",
	"careerbuilder.com",
	"simplyhired.com",
	"builtin.com",
	"levels.fyi",
	"crunchbase.com",
	"wikipedia.org",

	// ATS / job boards
	"greenhouse.io",
	"boards.greenhouse.io",
	"lever.co",
	"myworkdayjobs.com",
	"workday.com",
	"smartrecruiters.com",
	"icims.com",
	"jobvite.com",
	"applytojob.com",
}

func GetOrFindCompanyDomain(ctx context.Context, db *sql.DB, company string) (string, error) {
	// 1) cached?
	d, err := store.GetCompanyDomain(ctx, db, company)
	if err != nil {
		return "", err
	}
	if d != "" {
		return d, nil
	}

	// 2) search
	found, err := FindCompanyDomainDDG(ctx, company)
	if err != nil {
		return "", err
	}
	if found == "" {
		return "", nil
	}

	if isBlockedDomain(found) {
		return "", nil
	}

	// 3) store
	if err := store.UpsertCompanyDomain(ctx, db, company, found); err != nil {
		return "", err
	}
	return found, nil
}

func FindCompanyDomainDDG(ctx context.Context, company string) (string, error) {
	company = strings.TrimSpace(company)
	if company == "" {
		return "", nil
	}

	// Make query less noisy
	q := sanitizeCompanyForSearch(company)
	query := fmt.Sprintf("%s official website", q)

	u := "https://duckduckgo.com/html/?q=" + url.QueryEscape(query)

	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	req.Header.Set("User-Agent", "Mozilla/5.0")

	client := &http.Client{Timeout: 12 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", nil
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return "", nil
	}

	doc, err := goquery.NewDocumentFromReader(resp.Body)
	if err != nil {
		return "", nil
	}

	var best string

	// DDG HTML results: <a class="result__a" href="...">
	doc.Find("a.result__a").EachWithBreak(func(_ int, a *goquery.Selection) bool {
		href, ok := a.Attr("href")
		if !ok || strings.TrimSpace(href) == "" {
			return true
		}

		target := decodeDDGRedirect(href)
		host := hostFromURL(target)
		if host == "" {
			return true
		}

		host = strings.ToLower(strings.TrimPrefix(host, "www."))
		if isBlockedDomain(host) {
			return true
		}

		best = host
		return false // stop at first good domain
	})

	return best, nil
}

func decodeDDGRedirect(href string) string {
	u, err := url.Parse(href)
	if err != nil {
		return href
	}
	// DDG sometimes uses /l/?uddg=<urlencoded>
	if uddg := u.Query().Get("uddg"); uddg != "" {
		if dec, err := url.QueryUnescape(uddg); err == nil && dec != "" {
			return dec
		}
	}
	return href
}

func hostFromURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	if u.Host == "" {
		return ""
	}
	return u.Host
}

func isBlockedDomain(host string) bool {
	for _, b := range domainBlocklist {
		if host == b || strings.HasSuffix(host, "."+b) {
			return true
		}
	}
	return false
}

func sanitizeCompanyForSearch(s string) string {
	s = strings.TrimSpace(s)
	// remove common suffixes that confuse search
	repls := []string{
		", Inc.", "", " Inc.", "", " Inc", "",
		", LLC", "", " LLC", "",
		", Ltd.", "", " Ltd.", "", " Ltd", "",
		" Recruiting", "",
		" Staffing", "",
	}
	r := strings.NewReplacer(repls...)
	s = r.Replace(s)
	return strings.Join(strings.Fields(s), " ")
}
