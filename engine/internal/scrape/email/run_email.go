package email_scrape

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/url"

	//"sort"
	"strings"
	"time"

	"jobhunt-engine/internal/config"
	"jobhunt-engine/internal/domain"
	"jobhunt-engine/internal/rank"
	"jobhunt-engine/internal/store"

	"github.com/emersion/go-imap/v2"
)

type jobRow struct {
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

// RunEmailScrapeOnce scans UNSEEN emails, but ONLY those whose subject matches cfg.Email.SearchSubjectAny.
// It extracts job-ish URLs and inserts rows into jobs (deduped by source_id), then marks emails \Seen.
func RunEmailScrapeOnce(db *sql.DB, cfg config.Config, onNewJob func()) (added int, err error) {
	const (
		maxEmails        = 30
		maxLinksPerEmail = 20
		maxAdds          = 30
	)

	scorer := rank.YAMLScorer{Cfg: cfg}

	if db == nil {
		return 0, errors.New("db is nil")
	}
	if !cfg.Email.Enabled {
		return 0, nil
	}
	if cfg.Email.IMAPHost == "" || cfg.Email.Username == "" {
		return 0, errors.New("email enabled but missing imap_host/username")
	}
	if cfg.Email.AppPassword == "" {
		return 0, errors.New("missing email.app_password (gmail requires an app password with 2FA)")
	}

	addr := cfg.Email.IMAPHost
	if cfg.Email.IMAPPort != 0 && !strings.Contains(addr, ":") {
		addr = fmt.Sprintf("%s:%d", addr, cfg.Email.IMAPPort)
	} else if !strings.Contains(addr, ":") {
		addr += ":993"
	}

	mailbox := cfg.Email.Mailbox
	if mailbox == "" {
		mailbox = "INBOX"
	}

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	c, err := DialAndLoginIMAP(ctx, addr, cfg.Email.Username, cfg.Email.AppPassword, GmailTLSConfig())
	if err != nil {
		return 0, err
	}
	defer LogoutAndClose(c)

	if _, err := c.Select(mailbox, &imap.SelectOptions{ReadOnly: false}).Wait(); err != nil {
		return 0, fmt.Errorf("imap select %q: %w", mailbox, err)
	}

	msgs, err := FetchUnseen(ctx, c, maxEmails)
	if err != nil {
		return 0, err
	}
	if len(msgs) == 0 {
		return 0, nil
	}

	processed := make([]imap.UID, 0, len(msgs))

runLoop:
	for _, m := range msgs {
		//log.Printf("[email] Email found with subj: %s", m.Subject)
		receivedAt := m.Date
		msgID, bodyText, htmlBody, subj := parseRFC822(m.RawMessage, m.Subject)
		subj = decodeRFC2047(subj)

		// Require subject match when search_subject_any is set
		if len(cfg.Email.SearchSubjectAny) > 0 && !containsAnyCI(subj, cfg.Email.SearchSubjectAny) {
			processed = append(processed, m.UID)
			continue
		}
		log.Printf("[email] Email contains search params: %s", m.Subject)

		// --- LinkedIn Job Alert special-case
		if looksLikeLinkedInJobAlert(m.From, subj, bodyText) {
			log.Printf("[email] Email Looks like LinkedIn: %s", m.Subject)

			liJobs, perr := ParseLinkedInJobAlertHTML(htmlBody)
			//log.Printf("[email] LinkedIn parser: found %d jobs, err=%v", len(liJobs), perr)

			if perr == nil && len(liJobs) > 0 {
				for _, lj := range liJobs {
					desc := strings.Join([]string{
						subj,
						m.From,
						lj.Company + " · " + lj.Location,
						lj.Salary,
						lj.URL,
					}, "\n")
					sid := lj.SourceID
					if sid == "" {
						sid = makeSourceID(msgID, lj.URL, subj, m.From)
					}

					lead := domain.JobLead{
						CompanyName:     lj.Company,
						Title:           lj.Title,
						URL:             lj.URL,
						LocationRaw:     lj.Location,
						WorkMode:        inferWorkMode(lj.Location, subj),
						Description:     desc,
						PostedAt:        &receivedAt,
						FirstSeenSource: "email",
					}

					score, tags := scorer.Score(lead)

					j := jobRow{
						Company:        lj.Company,
						Title:          lj.Title,
						Location:       lj.Location,
						WorkMode:       inferWorkMode(lj.Location, subj),
						Description:    desc,
						URL:            lj.URL,
						Score:          score,
						Tags:           tags,
						ReceivedAt:     receivedAt.Local(),
						SourceID:       sid,
						CompanyLogoURL: lj.LogoURL,
					}
					domain, derr := GetOrFindCompanyDomain(ctx, db, j.Company)
					if derr != nil {
						log.Printf("[domain] error company=%q err=%v", j.Company, derr)
					}

					if domain != "" {
						faviconURL := "https://www.google.com/s2/favicons?domain=" + url.QueryEscape(domain) + "&sz=64"
						if key, _ := store.CacheLogoFromURL(ctx, db, faviconURL); key != "" {
							j.CompanyLogoURL = key // store logo_key in job row
						} else {
							j.CompanyLogoURL = ""
						}
					}

					// log.Printf("Job ready: %v", j)

					ok, ierr := insertJobIfNew(ctx, db, j)
					if ierr != nil {
						continue
					}
					if ok {
						added++
						if onNewJob != nil {
							onNewJob()
						}
						if added >= maxAdds {
							processed = append(processed, m.UID)
							break runLoop
						}
					}
				}

				processed = append(processed, m.UID)
				continue
			}
		}

		processed = append(processed, m.UID)
	}

	if len(processed) > 0 {
		if err := MarkSeen(c, processed); err != nil {
			return added, fmt.Errorf("mark seen: %w", err)
		}
	}

	return added, nil
}

func insertJobIfNew(ctx context.Context, db *sql.DB, j jobRow) (bool, error) {
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

func inferWorkMode(_ string, subject string) string {
	s := strings.ToLower(subject)
	switch {
	case strings.Contains(s, "remote"):
		return "remote"
	case strings.Contains(s, "hybrid"):
		return "hybrid"
	case strings.Contains(s, "on-site") || strings.Contains(s, "onsite") || strings.Contains(s, "on site"):
		return "onsite"
	default:
		return "unknown"
	}
}
