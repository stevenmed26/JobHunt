package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"
)

type Job struct {
	ID             int64    `json:"id"`
	Company        string   `json:"company"`
	Title          string   `json:"title"`
	Location       string   `json:"location"`
	WorkMode       string   `json:"workMode"`
	URL            string   `json:"url"`
	Score          int      `json:"score"`
	Tags           []string `json:"tags"`
	Date           string   `json:"date"`
	CompanyLogoURL string   `json:"companyLogoURL"`
	LogoKey        string   `json:"logoKey"`
}

type ListJobsOpts struct {
	Sort   string // score | date | company | title
	Order  string // asc | desc
	Window string // 24h | 7d | all
	Limit  int
}

func Migrate(db *sql.DB) error {

	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	var v int
	if err := tx.QueryRow(`PRAGMA user_version;`).Scan(&v); err != nil {
		return err
	}

	if v >= 1 {
		return tx.Commit()
	}

	// ---- Schema v1: tables ----

	if _, err := tx.Exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  location TEXT NOT NULL,
  work_mode TEXT NOT NULL,
  url TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '[]',
  date TEXT NOT NULL,
  source_id TEXT NOT NULL DEFAULT '',
  logo_key TEXT NOT NULL DEFAULT ''
);
`); err != nil {
		return err
	}

	if _, err := tx.Exec(`
CREATE TABLE IF NOT EXISTS logos (
  key TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  bytes BLOB NOT NULL,
  fetched_at TEXT NOT NULL
);
`); err != nil {
		return err
	}

	if _, err := tx.Exec(`
CREATE TABLE IF NOT EXISTS company_domains (
  company TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
`); err != nil {
		return err
	}

	// ---- Schema v1: indexes ----

	if _, err := tx.Exec(`
CREATE INDEX IF NOT EXISTS idx_company_domains_domain
ON company_domains(domain);
`); err != nil {
		return err
	}

	if _, err := tx.Exec(`
CREATE INDEX IF NOT EXISTS idx_jobs_date
ON jobs(date);
`); err != nil {
		return err
	}

	if _, err := tx.Exec(`
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_source_id
ON jobs(source_id)
WHERE source_id != '';
`); err != nil {
		return err
	}

	// Back-compat for dev DBs that might predate these columns.
	// (Technically unnecessary once you rely on user_version properly,
	// but it's harmless and useful during development.)
	if !columnExists(tx, "jobs", "source_id") {
		if _, err := tx.Exec(`ALTER TABLE jobs ADD COLUMN source_id TEXT NOT NULL DEFAULT '';`); err != nil {
			return err
		}
	}
	if !columnExists(tx, "jobs", "logo_key") {
		if _, err := tx.Exec(`ALTER TABLE jobs ADD COLUMN logo_key TEXT NOT NULL DEFAULT '';`); err != nil {
			return err
		}
	}

	// Mark schema v1
	if _, err := tx.Exec(`PRAGMA user_version = 1;`); err != nil {
		return err
	}

	return tx.Commit()
}

func columnExists(q interface {
	QueryRow(query string, args ...any) *sql.Row
}, table, col string) bool {
	query := fmt.Sprintf(`
SELECT 1
FROM pragma_table_info('%s')
WHERE name = ?
LIMIT 1;
`, table)

	var one int
	err := q.QueryRow(query, col).Scan(&one)
	return err == nil
}

func ListJobs(ctx context.Context, db *sql.DB, opts ListJobsOpts) ([]Job, error) {
	// defaults
	if opts.Sort == "" {
		opts.Sort = "score"
	}
	if opts.Window == "" {
		opts.Window = "7d"
	}
	// if opts.Limit <= 0 || opts.Limit > 2000 {
	// 	opts.Limit = 500
	// }

	// whitelist sort columns (prevents SQL injection)
	sortCol := map[string]string{
		"score":   "score",
		"date":    "date",
		"company": "company",
		"title":   "title",
	}[opts.Sort]
	if sortCol == "" {
		sortCol = "score"
	}
	switch opts.Sort {
	case "score":
		opts.Order = "desc"
	case "date":
		opts.Order = "desc"
	case "company":
		opts.Order = "asc"
	case "title":
		opts.Order = "asc"
	}

	// time window filter (date is TEXT; this assumes ISO8601/RFC3339 or SQLite-friendly datetime strings)
	where := ""
	switch opts.Window {
	case "24h":
		where = "WHERE date >= datetime('now','-24 hours')"
	case "7d":
		where = "WHERE date >= datetime('now','-7 days')"
	case "all":
		// no filter
	default:
		where = "WHERE date >= datetime('now','-7 days')"
	}

	query := fmt.Sprintf(`
SELECT id, company, title, location, work_mode, url, score, tags, date, logo_key
FROM jobs
%s
ORDER BY %s %s
LIMIT ?;
`, where, sortCol, opts.Order)

	rows, err := db.QueryContext(ctx, query, opts.Limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Job
	for rows.Next() {
		var j Job
		var tagsJSON string
		var dateStr string
		var parsedDate time.Time
		if err := rows.Scan(
			&j.ID,
			&j.Company,
			&j.Title,
			&j.Location,
			&j.WorkMode,
			&j.URL,
			&j.Score,
			&tagsJSON,
			&dateStr,
			&j.LogoKey,
		); err != nil {
			return nil, err
		}
		// Build URL for UI
		if j.LogoKey != "" {
			j.CompanyLogoURL = "/logo/" + j.LogoKey
		} else {
			j.CompanyLogoURL = ""
		}
		//log.Printf("logo_key=%q companyLogoURL=%q", j.LogoKey, j.CompanyLogoURL)
		//log.Printf("Logo URL: http://127.0.0.1:38471%s", j.CompanyLogoURL)
		_ = json.Unmarshal([]byte(tagsJSON), &j.Tags)
		parsedDate, _ = time.Parse(time.RFC3339, dateStr)
		j.Date = parsedDate.Format("2006-01-02 15:04:05")
		out = append(out, j)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
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

func CleanupOldJobs(db *sql.DB) (deleted int64, err error) {
	res, err := db.Exec(`
DELETE FROM jobs
WHERE date < datetime('now', '-3 months');
`)
	if err != nil {
		return 0, fmt.Errorf("cleanup old jobs: %w", err)
	}
	n, _ := res.RowsAffected()
	return n, nil
}
