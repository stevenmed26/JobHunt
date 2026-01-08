package email_scrape

import (
	"context"
	"database/sql"
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
	"jobhunt-engine/internal/scrape"
	"jobhunt-engine/internal/store"

	"github.com/emersion/go-imap/v2"
)

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
		msgID, bodyText, htmlBody, subj := scrape.ParseRFC822(m.RawMessage, m.Subject)
		subj = scrape.DecodeRFC2047(subj)

		// Require subject match when search_subject_any is set
		if len(cfg.Email.SearchSubjectAny) > 0 && !scrape.ContainsAnyCI(subj, cfg.Email.SearchSubjectAny) {
			processed = append(processed, m.UID)
			continue
		}
		//log.Printf("[email] Email contains search params: %s", m.Subject)

		// --- LinkedIn Job Alert special-case
		if looksLikeLinkedInJobAlert(m.From, subj, bodyText) {
			//log.Printf("[email] Email Looks like LinkedIn: %s", m.Subject)

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
						sid = scrape.MakeSourceID(msgID, lj.URL, subj, m.From)
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

					j := scrape.JobRow{
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
					keep, why := scrape.ShouldKeepJob(cfg, lead)
					if !keep {
						log.Printf("[email:%s] skipped (%s) title=%q loc=%q url=%q",
							lead.CompanyName, why, lead.Title, lead.LocationRaw, lead.URL)
						continue
					}
					ok, ierr := scrape.InsertJobIfNew(ctx, db, j)
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

func inferWorkMode(location string, subject string) string {
	s := strings.ToLower(subject)
	l := strings.ToLower(location)
	switch {
	case strings.Contains(s, "remote") || strings.Contains(l, "remote"):
		return "Remote"
	case strings.Contains(s, "hybrid") || strings.Contains(l, "hybrid"):
		return "Hybrid"
	case strings.Contains(s, "on-site") || strings.Contains(s, "onsite") || strings.Contains(s, "on site") || strings.Contains(l, "on-site") || strings.Contains(l, "onsite") || strings.Contains(l, "on site"):
		return "Onsite"
	default:
		return "Unknown"
	}
}
