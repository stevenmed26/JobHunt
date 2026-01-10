package scrape

import (
	"context"
	"database/sql"
	"jobhunt-engine/internal/config"
	email_scrape "jobhunt-engine/internal/scrape/email"
	"jobhunt-engine/internal/scrape/greenhouse"
	"jobhunt-engine/internal/scrape/lever"
	"jobhunt-engine/internal/scrape/types"
	"log"
	"time"

	"golang.org/x/sync/errgroup"
)

func PollOnce(db *sql.DB, cfg config.Config, onNewJob func()) (added int, err error) {
	parent := context.Background()

	// Build list based on enabled flags
	var fetchers []types.Fetcher

	if cfg.Sources.Greenhouse.Enabled {
		gh := greenhouse.New(greenhouse.Config{Companies: mapGreenhouseCompanies(cfg.Sources.Greenhouse.Companies)})
		fetchers = append(fetchers, gh)
	}
	if cfg.Sources.Lever.Enabled {
		lv := lever.New(lever.Config{Companies: mapLeverCompanies(cfg.Sources.Lever.Companies)})
		fetchers = append(fetchers, lv)
	}
	if cfg.Email.Enabled {
		fetchers = append(fetchers, &email_scrape.EmailFetcher{Cfg: cfg})
	}

	var g errgroup.Group

	results := make(chan types.ScrapeResult, len(fetchers))

	for _, f := range fetchers {
		f := f

		g.Go(func() error {
			timeout := 2 * time.Minute
			switch f.Name() {
			case "greenhouse":
				timeout = 5 * time.Minute
			case "lever":
				timeout = 5 * time.Minute
			case "email":
				timeout = 2 * time.Minute
			}

			fctx, cancel := context.WithTimeout(parent, timeout)
			defer cancel()

			log.Printf("[%s] Running...", f.Name())
			res, err := f.Fetch(fctx)
			if err != nil {
				log.Printf("[ats:%s] error: %v", f.Name(), err)
				return nil // best-effort: don’t cancel siblings
			}
			results <- res
			return nil
		})
	}

	_ = g.Wait()
	close(results)

	totalAdded := 0

	insertCtx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	// Process leads first
	var finals []func(context.Context) error
	for res := range results {
		log.Printf("[poll] got source=%s leads=%d finalize=%v",
			res.Source, len(res.Leads), res.Finalize != nil)
		if len(res.Leads) > 0 {
			added := ProcessLeads(insertCtx, db, cfg, res.Leads, onNewJob)
			totalAdded += added
		}

		if res.Finalize != nil {
			finals = append(finals, res.Finalize)
		}
	}

	return totalAdded, nil
}

func mapGreenhouseCompanies(in []config.Company) []greenhouse.Company {
	out := make([]greenhouse.Company, 0, len(in))
	for _, c := range in {
		out = append(out, greenhouse.Company{
			Slug: c.Slug,
			Name: c.Name,
		})
	}
	return out
}

func mapLeverCompanies(in []config.Company) []lever.Company {
	out := make([]lever.Company, 0, len(in))
	for _, c := range in {
		out = append(out, lever.Company{
			Slug: c.Slug,
			Name: c.Name,
		})
	}
	return out
}
