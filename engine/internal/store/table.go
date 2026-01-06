package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"
)

type Job struct {
	ID       int64    `json:"id"`
	Company  string   `json:"company"`
	Title    string   `json:"title"`
	Location string   `json:"location"`
	WorkMode string   `json:"workMode"`
	URL      string   `json:"url"`
	Score    int      `json:"score"`
	Tags     []string `json:"tags"`
	Date     string   `json:"date"`
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
  date TEXT NOT NULL
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
SELECT id, company, title, location, work_mode, url, score, tags, date
FROM jobs
ORDER BY date DESC
LIMIT 200;`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Job
	for rows.Next() {
		var j Job
		var tagsJSON string
		var dateStr string
		var datePrs time.Time
		if err := rows.Scan(&j.ID, &j.Company, &j.Title, &j.Location, &j.WorkMode, &j.URL, &j.Score, &tagsJSON, &dateStr); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(tagsJSON), &j.Tags)
		datePrs, _ = time.Parse(time.RFC3339, dateStr)
		j.Date = datePrs.Format("2006-01-02 15:04:05")
		out = append(out, j)
	}
	return out, rows.Err()
}

func SeedJob(ctx context.Context, db *sql.DB) (Job, error) {
	j := Job{
		Company:  "SeedCo",
		Title:    "SRE / Platform Engineer (DFW or Remote)",
		Location: "Dallas-Fort Worth, TX",
		WorkMode: "remote",
		URL:      "https://example.com/apply",
		Score:    88,
		Tags:     []string{"SRE", "Kubernetes", "Terraform", "AWS", "Go"},
		Date:     time.Now().UTC().Format("2006-01-02 15:04:05"),
	}
	tagsB, _ := json.Marshal(j.Tags)
	res, err := db.ExecContext(ctx, `
INSERT INTO jobs(company, title, location, work_mode, url, score, tags, date)
VALUES(?,?,?,?,?,?,?,?);`,
		j.Company, j.Title, j.Location, j.WorkMode, j.URL, j.Score, string(tagsB), j.Date)
	if err != nil {
		return Job{}, err
	}
	j.ID, _ = res.LastInsertId()
	return j, nil
}
