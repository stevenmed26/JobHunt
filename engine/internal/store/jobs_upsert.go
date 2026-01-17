package store

import (
	"database/sql"
	"fmt"
	"strings"
)

type JobInsert struct {
	Company  string
	Title    string
	Location string
	WorkMode string
	URL      string
	Score    int
	TagsJSON string // "[]"
	Date     string
	LogoKey  string
	SourceID string
}

func InsertJobIgnore(db *sql.DB, j JobInsert) (added bool, err error) {
	_, err = db.Exec(`
INSERT OR IGNORE INTO jobs (company, title, location, work_mode, url, score, tags, date, logo_key, source_id)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
		j.Company, j.Title, j.Location, j.WorkMode, j.URL, j.Score, j.TagsJSON, j.Date, j.LogoKey, j.SourceID,
	)
	if err != nil {
		return false, fmt.Errorf("insert job: %w", err)
	}

	var exists int
	_ = db.QueryRow(`SELECT 1 FROM jobs WHERE source_id = ? LIMIT 1;`, j.SourceID).Scan(&exists)
	var changes int
	if e := db.QueryRow(`SELECT changes();`).Scan(&changes); e == nil {
		return changes > 0, nil
	}
	return true, nil
}

func NormalizeWorkMode(mode string) string {
	m := strings.ToLower(strings.TrimSpace(mode))
	switch {
	case strings.Contains(m, "remote"):
		return "Remote"
	case strings.Contains(m, "hybrid"):
		return "Hybrid"
	case m == "":
		return "Unknown"
	default:
		return mode
	}
}
