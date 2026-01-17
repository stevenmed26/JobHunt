package scrape

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"jobhunt-engine/internal/config"
	"jobhunt-engine/internal/domain"
	"jobhunt-engine/internal/rank"
	"jobhunt-engine/internal/scrape/greenhouse"
	"jobhunt-engine/internal/scrape/lever"
	"jobhunt-engine/internal/scrape/types"
	"jobhunt-engine/internal/scrape/util"
	"jobhunt-engine/internal/store"
	"log"
	"net/url"
	"strings"
	"time"
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

func InsertJobIfNew(ctx context.Context, db *sql.DB, j types.JobRow) (bool, error) {
	if j.Company == "" {
		j.Company = "Unknown"
	}
	if j.Title == "" {
		j.Title = "Job Posting"
	}
	if j.Location == "" {
		j.Location = "Unknown"
	}
	if j.WorkMode == "" {
		j.WorkMode = "Unknown"
	}
	if j.URL == "" {
		return false, errors.New("missing url")
	}
	if j.ReceivedAt.IsZero() {
		j.ReceivedAt = time.Now().UTC()
	}
	if j.SourceID == "" {
		j.SourceID = util.ComputeSourceID(j)
	} else {
		j.SourceID = strings.TrimSpace(j.SourceID)
	}

	tagsB, _ := json.Marshal(j.Tags)

	res, err := db.ExecContext(ctx, `
INSERT OR IGNORE INTO jobs(company, title, location, work_mode, url, score, tags, date, source_id, seen_from_source, logo_key)
VALUES(?,?,?,?,?,?,?,?,?,?,?);`,
		j.Company,
		j.Title,
		j.Location,
		j.WorkMode,
		j.URL,
		j.Score,
		string(tagsB),
		j.ReceivedAt.Format(time.RFC3339),
		j.SourceID,
		j.SeenFromSource,
		j.CompanyLogoURL,
	)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	if n == 0 && j.CompanyLogoURL != "" {
		// job already existed; backfill logo_key if missing
		_, _ = db.ExecContext(ctx, `
UPDATE jobs
SET logo_key = ?
WHERE source_id = ?
  AND (logo_key = '' OR logo_key IS NULL);`,
			j.CompanyLogoURL, j.SourceID,
		)
	}

	//log.Println("New job added to DB")
	return n > 0, nil
}

func jobRowFromLead(lead domain.JobLead, s rank.YAMLScorer) types.JobRow {
	recv := time.Now().UTC()
	if lead.PostedAt != nil && !lead.PostedAt.IsZero() {
		recv = lead.PostedAt.UTC()
	}

	score, tags := s.Score(lead)

	sourceID := strings.TrimSpace(lead.ATSJobID)
	if sourceID == "" {
		// Match InsertJobIfNew fallback so UPDATEs can find the row
		sourceID = util.HashString("url:" + strings.TrimSpace(lead.URL))
	}

	return types.JobRow{
		Company:        strings.TrimSpace(lead.CompanyName),
		Title:          strings.TrimSpace(lead.Title),
		Location:       strings.TrimSpace(lead.LocationRaw),
		WorkMode:       strings.TrimSpace(lead.WorkMode),
		URL:            strings.TrimSpace(lead.URL),
		Score:          score,
		Tags:           tags,
		ReceivedAt:     recv,
		SourceID:       sourceID,
		SeenFromSource: strings.TrimSpace(lead.FirstSeenSource),
		CompanyLogoURL: strings.TrimSpace(lead.CompanyLogoURL),
	}
}

func MapGreenhouseCompanies(in []config.Company) []greenhouse.Company {
	out := make([]greenhouse.Company, 0, len(in))
	for _, c := range in {
		out = append(out, greenhouse.Company{
			Slug: c.Slug,
			Name: c.Name,
		})
	}
	return out
}

func MapLeverCompanies(in []config.Company) []lever.Company {
	out := make([]lever.Company, 0, len(in))
	for _, c := range in {
		out = append(out, lever.Company{
			Slug: c.Slug,
			Name: c.Name,
		})
	}
	return out
}
