package poll

import (
	"context"
	"database/sql"
	"jobhunt-engine/internal/config"
	"jobhunt-engine/internal/scrape"
	email_scrape "jobhunt-engine/internal/scrape/email"
	"jobhunt-engine/internal/scrape/greenhouse"
	"jobhunt-engine/internal/scrape/lever"
	"jobhunt-engine/internal/scrape/types"
	"jobhunt-engine/internal/scrape/util"
	"log"
	"time"

	"golang.org/x/sync/errgroup"
)

func PollOnce(db *sql.DB, cfg config.Config, onNewJob func()) (added int, err error) {
	parent := context.Background()

	limiter := util.NewHostLimiter(1.0, 2)

	// Build list based on enabled flags
	var fetchers []types.Fetcher

	if cfg.Sources.Greenhouse.Enabled {
		gh := greenhouse.New(greenhouse.Config{Companies: scrape.MapGreenhouseCompanies(cfg.Sources.Greenhouse.Companies)}, limiter)
		fetchers = append(fetchers, gh)
	}
	if cfg.Sources.Lever.Enabled {
		lv := lever.New(lever.Config{Companies: scrape.MapLeverCompanies(cfg.Sources.Lever.Companies)}, limiter)
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
				return nil
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
			added := scrape.ProcessLeads(insertCtx, db, cfg, res.Leads, onNewJob)
			totalAdded += added
		}

		if res.Finalize != nil {
			finals = append(finals, res.Finalize)
		}
	}

	return totalAdded, nil
}
