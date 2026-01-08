package scrape

import (
	"context"
	"database/sql"
	"log"
	"strings"

	"jobhunt-engine/internal/config"
	"jobhunt-engine/internal/domain"
	"jobhunt-engine/internal/scrape/greenhouse"
	"jobhunt-engine/internal/scrape/lever"
)

// RunATSScrapeOnce runs enabled ATS scrapers (Greenhouse/Lever) and inserts jobs into SQLite.
// It returns how many NEW jobs were added (dedupe via source_id).
func RunATSScrapeOnce(ctx context.Context, db *sql.DB, cfg config.Config) (added int, err error) {
	if db == nil {
		return 0, nil
	}

	// Build greenhouse scraper if enabled
	var gh *greenhouse.Scraper
	if cfg.Sources.Greenhouse.Enabled && len(cfg.Sources.Greenhouse.Companies) > 0 {
		companies := make([]greenhouse.Company, 0, len(cfg.Sources.Greenhouse.Companies))
		for _, c := range cfg.Sources.Greenhouse.Companies {
			slug := strings.TrimSpace(c.Slug)
			if slug == "" {
				continue
			}
			name := strings.TrimSpace(c.Name)
			if name == "" {
				name = slug
			}
			companies = append(companies, greenhouse.Company{Slug: slug, Name: name})
		}
		if len(companies) > 0 {
			gh = greenhouse.New(greenhouse.Config{Companies: companies})
		}
	}

	// Build lever scraper if enabled
	var lv *lever.Scraper
	if cfg.Sources.Lever.Enabled && len(cfg.Sources.Lever.Companies) > 0 {
		companies := make([]lever.Company, 0, len(cfg.Sources.Lever.Companies))
		for _, c := range cfg.Sources.Lever.Companies {
			slug := strings.TrimSpace(c.Slug)
			if slug == "" {
				continue
			}
			name := strings.TrimSpace(c.Name)
			if name == "" {
				name = slug
			}
			companies = append(companies, lever.Company{Slug: slug, Name: name})
		}
		if len(companies) > 0 {
			lv = lever.New(lever.Config{Companies: companies})
		}
	}

	if gh == nil && lv == nil {
		return 0, nil
	}

	run := func(name string, fetch func(context.Context) ([]domain.JobLead, error)) {
		jobs, e := fetch(ctx)
		if e != nil {
			log.Printf("[ats:%s] fetch error: %v", name, e)
			return
		}

		addedHere := 0
		for _, lead := range jobs {
			keep, why := ShouldKeepJob(cfg, lead)
			if !keep {
				log.Printf("[ats:%s] skipped (%s) title=%q loc=%q url=%q",
					name, why, lead.Title, lead.LocationRaw, lead.URL)
				continue
			}
			row := jobRowFromLead(lead)
			ok, e := InsertJobIfNew(ctx, db, row)
			if e != nil {
				log.Printf("[ats:%s] insert error source_id=%q url=%q err=%v", name, row.SourceID, row.URL, e)
				continue
			}
			if ok {
				added++
				addedHere++
			}
		}
		log.Printf("[ats:%s] fetched=%d added=%d", name, len(jobs), addedHere)
	}

	if gh != nil {
		run("greenhouse", gh.Fetch)
	}
	if lv != nil {
		run("lever", lv.Fetch)
	}

	return added, nil
}
