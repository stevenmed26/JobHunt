package store

import (
	"context"
	"database/sql"
	"strings"
	"time"
)

// GetCompanyDomain returns cached domain or "" if missing.
func GetCompanyDomain(ctx context.Context, db *sql.DB, company string) (string, error) {
	company = normalizeCompanyKey(company)
	if company == "" {
		return "", nil
	}

	var domain string
	err := db.QueryRowContext(ctx,
		`SELECT domain FROM company_domains WHERE company = ? LIMIT 1;`,
		company,
	).Scan(&domain)

	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(domain), nil
}

func UpsertCompanyDomain(ctx context.Context, db *sql.DB, company, domain string) error {
	company = normalizeCompanyKey(company)
	domain = strings.ToLower(strings.TrimSpace(domain))

	if company == "" || domain == "" {
		return nil
	}

	_, err := db.ExecContext(ctx, `
INSERT INTO company_domains(company, domain, fetched_at)
VALUES(?,?,?)
ON CONFLICT(company) DO UPDATE SET
  domain = excluded.domain,
  fetched_at = excluded.fetched_at;
`, company, domain, time.Now().UTC().Format(time.RFC3339))

	return err
}

func normalizeCompanyKey(s string) string {
	s = strings.TrimSpace(s)
	s = strings.Join(strings.Fields(s), " ")
	s = strings.ToLower(s)
	return s
}
