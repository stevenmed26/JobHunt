package scrape

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"jobhunt-engine/internal/domain"
	"jobhunt-engine/internal/rank"
	"jobhunt-engine/internal/scrape/util"
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
		j.SourceID = util.HashString("url:" + j.URL)
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

func jobRowFromLead(lead domain.JobLead, s rank.YAMLScorer) JobRow {
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

	return JobRow{
		Company:        strings.TrimSpace(lead.CompanyName),
		Title:          strings.TrimSpace(lead.Title),
		Location:       strings.TrimSpace(lead.LocationRaw),
		WorkMode:       strings.TrimSpace(lead.WorkMode),
		URL:            strings.TrimSpace(lead.URL),
		Score:          score,
		Tags:           tags,
		ReceivedAt:     recv,
		SourceID:       sourceID,
		CompanyLogoURL: strings.TrimSpace(lead.CompanyLogoURL),
	}
}
