package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"
)

type Job struct {
	ID        int64     `json:"id"`
	Company   string    `json:"company"`
	Title     string    `json:"title"`
	Location  string    `json:"location"`
	WorkMode  string    `json:"workMode"`
	URL       string    `json:"url"`
	Score     int       `json:"score"`
	Tags      []string  `json:"tags"`
	FirstSeen time.Time `json:"firstSeen"`
}

func Migrate(db *sql.DB) error {
	if _, err := db.Exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  location TEXT NOT NULL,
  work_mode TEXT NOT NULL,
  url TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '[]',
  first_seen TEXT NOT NULL
);`); err != nil {
		return err
	}

	// Does column exist?
	var one int
	err := db.QueryRow(`
SELECT 1
FROM pragma_table_info('jobs')
WHERE name = 'source_id'
LIMIT 1;
`).Scan(&one)

	has := true
	if err == sql.ErrNoRows {
		has = false
	} else if err != nil {
		return err
	}

	if !has {
		if _, err := db.Exec(`ALTER TABLE jobs ADD COLUMN source_id TEXT NOT NULL DEFAULT '';`); err != nil {
			return err
		}
	}

	if _, err := db.Exec(`
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_source_id
ON jobs(source_id)
WHERE source_id != '';
`); err != nil {
		return err
	}

	return nil
}

func ListJobs(ctx context.Context, db *sql.DB) ([]Job, error) {
	rows, err := db.QueryContext(ctx, `
SELECT id, company, title, location, work_mode, url, score, tags, first_seen
FROM jobs
ORDER BY first_seen DESC
LIMIT 200;`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Job
	for rows.Next() {
		var j Job
		var tagsJSON string
		var firstSeenStr string
		if err := rows.Scan(&j.ID, &j.Company, &j.Title, &j.Location, &j.WorkMode, &j.URL, &j.Score, &tagsJSON, &firstSeenStr); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(tagsJSON), &j.Tags)
		j.FirstSeen, _ = time.Parse(time.RFC3339, firstSeenStr)
		out = append(out, j)
	}
	return out, rows.Err()
}

func SeedJob(ctx context.Context, db *sql.DB) (Job, error) {
	j := Job{
		Company:   "SeedCo",
		Title:     "SRE / Platform Engineer (DFW or Remote)",
		Location:  "Dallas-Fort Worth, TX",
		WorkMode:  "remote",
		URL:       "https://example.com/apply",
		Score:     88,
		Tags:      []string{"SRE", "Kubernetes", "Terraform", "AWS", "Go"},
		FirstSeen: time.Now().UTC(),
	}
	tagsB, _ := json.Marshal(j.Tags)
	res, err := db.ExecContext(ctx, `
INSERT INTO jobs(company, title, location, work_mode, url, score, tags, first_seen)
VALUES(?,?,?,?,?,?,?,?);`,
		j.Company, j.Title, j.Location, j.WorkMode, j.URL, j.Score, string(tagsB), j.FirstSeen.Format(time.RFC3339))
	if err != nil {
		return Job{}, err
	}
	j.ID, _ = res.LastInsertId()
	return j, nil
}
