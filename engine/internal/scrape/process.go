package scrape

import (
	"context"
	"database/sql"
	"jobhunt-engine/internal/config"
	"jobhunt-engine/internal/domain"
	"jobhunt-engine/internal/rank"
	"jobhunt-engine/internal/store"
	"log"
	"net/url"
)

func ProcessLeads(ctx context.Context, db *sql.DB, cfg config.Config, leads []domain.JobLead, onNewJob func()) (added int) {
	scorer := rank.YAMLScorer{Cfg: cfg}

	// Run-local caches (reset every poll)
	domainCache := make(map[string]string) // company -> domain
	logoCache := make(map[string]string)   // domain -> logo_key

	for _, lead := range leads {
		keep, why := ShouldKeepJob(cfg, lead)
		if !keep {
			log.Printf("[%s] skipped (%s) title=%q loc=%q url=%q",
				lead.FirstSeenSource, why, lead.Title, lead.LocationRaw, lead.URL)
			continue
		}

		j := jobRowFromLead(lead, scorer)

		// Fast path: insert first, no enrichment
		ok, ierr := InsertJobIfNew(ctx, db, j)
		if ierr != nil {
			log.Printf("[process:%s] insert error: %v title=%q url=%q source_id=%q",
				lead.FirstSeenSource, ierr, lead.Title, lead.URL, j.SourceID)
			continue
		}
		if !ok {
			continue
		}

		// --- Logo enrichment (only for newly inserted jobs)

		// 1) Domain lookup (cached by company name)
		dom, ok := domainCache[j.Company]
		if !ok {
			found, derr := FindCompanyDomainDDG(ctx, j.Company)
			if derr != nil {
				log.Printf("[logo] domain lookup err company=%q err=%v", j.Company, derr)
			}
			dom = found
			domainCache[j.Company] = dom // cache even if empty
		}

		// 2) Favicon lookup (cached by domain)
		if dom != "" {
			log.Printf("[logo] no domain company=%q", j.Company)
			key, ok := logoCache[dom]
			if !ok {
				faviconURL := "https://www.google.com/s2/favicons?domain=" +
					url.QueryEscape(dom) + "&sz=64"

				if k, _ := store.CacheLogoFromURL(ctx, db, faviconURL); k != "" {
					key = k
				}
				logoCache[dom] = key // cache empty to avoid retry storms
			}

			// 3) Backfill logo_key if we got one
			if key != "" {
				_, _ = db.ExecContext(ctx, `
UPDATE jobs
SET logo_key = ?
WHERE source_id = ?
  AND (logo_key = '' OR logo_key IS NULL);`,
					key, j.SourceID,
				)
				log.Printf("[logo] updating company=%q source_id=%q dom=%q key=%q", j.Company, j.SourceID, dom, key)
			}
		}

		added++
		if onNewJob != nil {
			onNewJob()
		}
	}

	return added
}
