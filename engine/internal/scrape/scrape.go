package scrape

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"jobhunt-engine/internal/domain"
	"strings"
	"time"
)

type JobRow struct {
	Company        string
	Title          string
	Location       string
	WorkMode       string
	Description    string
	URL            string
	Score          int
	Tags           []string
	ReceivedAt     time.Time
	SourceID       string
	CompanyLogoURL string
}

func InsertJobIfNew(ctx context.Context, db *sql.DB, j JobRow) (bool, error) {
	if j.Company == "" {
		j.Company = "Unknown"
	}
	if j.Title == "" {
		j.Title = "Job Posting"
	}
	if j.Location == "" {
		j.Location = "unknown"
	}
	if j.WorkMode == "" {
		j.WorkMode = "unknown"
	}
	if j.URL == "" {
		return false, errors.New("missing url")
	}
	if j.ReceivedAt.IsZero() {
		j.ReceivedAt = time.Now().UTC()
	}
	if j.SourceID == "" {
		j.SourceID = hashString("url:" + j.URL)
	}

	tagsB, _ := json.Marshal(j.Tags)

	res, err := db.ExecContext(ctx, `
INSERT OR IGNORE INTO jobs(company, title, location, work_mode, url, score, tags, date, source_id, logo_key)
VALUES(?,?,?,?,?,?,?,?,?,?);`,
		j.Company,
		j.Title,
		j.Location,
		j.WorkMode,
		j.URL,
		j.Score,
		string(tagsB),
		j.ReceivedAt.Format(time.RFC3339),
		j.SourceID,
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

func jobRowFromLead(j domain.JobLead) JobRow {
	// Date: use PostedAt if present, else now UTC
	recv := time.Now().UTC()
	if j.PostedAt != nil && !j.PostedAt.IsZero() {
		recv = j.PostedAt.UTC()
	}

	// Use ATSJobID as SourceID (stable, dedupes perfectly)
	sourceID := strings.TrimSpace(j.ATSJobID)
	if sourceID == "" {
		// fallback handled by InsertJobIfNew (hash(url))
		sourceID = ""
	}

	return JobRow{
		Company:        strings.TrimSpace(j.CompanyName),
		Title:          strings.TrimSpace(j.Title),
		Location:       strings.TrimSpace(j.LocationRaw),
		WorkMode:       strings.TrimSpace(j.WorkMode),
		URL:            strings.TrimSpace(j.URL),
		Score:          0,
		Tags:           nil, // []string{} if your type requires non-nil
		ReceivedAt:     recv,
		SourceID:       sourceID,
		CompanyLogoURL: "", // ATS scrapers don’t have logos yet
	}
}
