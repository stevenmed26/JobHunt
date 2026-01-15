package email_scrape

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"

	//"sort"
	"strings"

	"jobhunt-engine/internal/config"
	"jobhunt-engine/internal/domain"
	"jobhunt-engine/internal/scrape/types"
	"jobhunt-engine/internal/scrape/util"
	"jobhunt-engine/internal/secrets"

	"github.com/emersion/go-imap/v2"
)

type EmailFetcher struct {
	Cfg config.Config
	DB  *sql.DB
}

func (e EmailFetcher) Name() string { return "email" }

// RunEmailScrapeOnce scans UNSEEN emails, but ONLY those whose subject matches cfg.Email.SearchSubjectAny.
// It extracts job-ish URLs and inserts rows into jobs (deduped by source_id), then marks emails \Seen.
// func RunEmailScrapeOnce(db *sql.DB, cfg config.Config, onNewJob func()) (added int, err error) {
// 	const (
// 		maxEmails        = 30
// 		maxLinksPerEmail = 20
// 		maxAdds          = 30
// 	)

// 	scorer := rank.YAMLScorer{Cfg: cfg}

// 	if db == nil {
// 		return 0, errors.New("db is nil")
// 	}
// 	if !cfg.Email.Enabled {
// 		return 0, nil
// 	}
// 	if cfg.Email.IMAPHost == "" || cfg.Email.Username == "" {
// 		return 0, errors.New("email enabled but missing imap_host/username")
// 	}
// 	if cfg.Email.AppPassword == "" {
// 		return 0, errors.New("missing email.app_password (gmail requires an app password with 2FA)")
// 	}

// 	addr := cfg.Email.IMAPHost
// 	if cfg.Email.IMAPPort != 0 && !strings.Contains(addr, ":") {
// 		addr = fmt.Sprintf("%s:%d", addr, cfg.Email.IMAPPort)
// 	} else if !strings.Contains(addr, ":") {
// 		addr += ":993"
// 	}

// 	mailbox := cfg.Email.Mailbox
// 	if mailbox == "" {
// 		mailbox = "INBOX"
// 	}

// 	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
// 	defer cancel()

// 	c, err := DialAndLoginIMAP(ctx, addr, cfg.Email.Username, cfg.Email.AppPassword, GmailTLSConfig())
// 	if err != nil {
// 		return 0, err
// 	}
// 	defer LogoutAndClose(c)

// 	if _, err := c.Select(mailbox, &imap.SelectOptions{ReadOnly: false}).Wait(); err != nil {
// 		return 0, fmt.Errorf("imap select %q: %w", mailbox, err)
// 	}

// 	msgs, err := FetchUnseen(ctx, c, maxEmails)
// 	if err != nil {
// 		return 0, err
// 	}
// 	if len(msgs) == 0 {
// 		return 0, nil
// 	}

// 	processed := make([]imap.UID, 0, len(msgs))

// runLoop:
// 	for _, m := range msgs {
// 		//log.Printf("[email] Email found with subj: %s", m.Subject)
// 		receivedAt := m.Date
// 		msgID, bodyText, htmlBody, subj := util.ParseRFC822(m.RawMessage, m.Subject)
// 		subj = util.DecodeRFC2047(subj)

// 		// Require subject match when search_subject_any is set
// 		if len(cfg.Email.SearchSubjectAny) > 0 && !util.ContainsAnyCI(subj, cfg.Email.SearchSubjectAny) {
// 			processed = append(processed, m.UID)
// 			continue
// 		}
// 		//log.Printf("[email] Email contains search params: %s", m.Subject)

// 		// --- LinkedIn Job Alert special-case
// 		if looksLikeLinkedInJobAlert(m.From, subj, bodyText) {
// 			//log.Printf("[email] Email Looks like LinkedIn: %s", m.Subject)

// 			liJobs, perr := ParseLinkedInJobAlertHTML(htmlBody)
// 			//log.Printf("[email] LinkedIn parser: found %d jobs, err=%v", len(liJobs), perr)

// 			if perr == nil && len(liJobs) > 0 {
// 				for _, lj := range liJobs {
// 					desc := strings.Join([]string{
// 						subj,
// 						m.From,
// 						lj.Company + " · " + lj.Location,
// 						lj.Salary,
// 						lj.URL,
// 					}, "\n")
// 					sid := lj.SourceID
// 					if sid == "" {
// 						sid = types.MakeSourceID(msgID, lj.URL, subj, m.From)
// 					}

// 					lead := domain.JobLead{
// 						CompanyName:     lj.Company,
// 						Title:           lj.Title,
// 						URL:             lj.URL,
// 						LocationRaw:     lj.Location,
// 						WorkMode:        inferWorkMode(lj.Location, subj),
// 						Description:     desc,
// 						PostedAt:        &receivedAt,
// 						FirstSeenSource: "email",
// 					}

// 					score, tags := scorer.Score(lead)

// 					j := types.JobRow{
// 						Company:        lj.Company,
// 						Title:          lj.Title,
// 						Location:       lj.Location,
// 						WorkMode:       inferWorkMode(lj.Location, subj),
// 						Description:    desc,
// 						URL:            lj.URL,
// 						Score:          score,
// 						Tags:           tags,
// 						ReceivedAt:     receivedAt.Local(),
// 						SourceID:       sid,
// 						CompanyLogoURL: lj.LogoURL,
// 					}
// 					domain, derr := util.GetOrFindCompanyDomain(ctx, db, j.Company)
// 					if derr != nil {
// 						log.Printf("[domain] error company=%q err=%v", j.Company, derr)
// 					}

// 					if domain != "" {
// 						faviconURL := "https://www.google.com/s2/favicons?domain=" + url.QueryEscape(domain) + "&sz=64"
// 						if key, _ := store.CacheLogoFromURL(ctx, db, faviconURL); key != "" {
// 							j.CompanyLogoURL = key // store logo_key in job row
// 						} else {
// 							j.CompanyLogoURL = ""
// 						}
// 					}

// 					// log.Printf("Job ready: %v", j)
// 					keep, why := types.ShouldKeepJob(cfg, lead)
// 					if !keep {
// 						log.Printf("[email:%s] skipped (%s) title=%q loc=%q url=%q",
// 							lead.CompanyName, why, lead.Title, lead.LocationRaw, lead.URL)
// 						continue
// 					}
// 					ok, ierr := types.InsertJobIfNew(ctx, db, j)
// 					if ierr != nil {
// 						continue
// 					}
// 					if ok {
// 						added++
// 						if onNewJob != nil {
// 							onNewJob()
// 						}
// 						if added >= maxAdds {
// 							processed = append(processed, m.UID)
// 							break runLoop
// 						}
// 					}
// 				}

// 				processed = append(processed, m.UID)
// 				continue
// 			}
// 		}

// 		processed = append(processed, m.UID)
// 	}

// 	if len(processed) > 0 {
// 		if err := MarkSeen(c, processed); err != nil {
// 			return added, fmt.Errorf("mark seen: %w", err)
// 		}
// 	}

// 	return added, nil
// }

func (e *EmailFetcher) Fetch(ctx context.Context) (types.ScrapeResult, error) {
	cfg := e.Cfg

	const (
		maxEmails        = 30
		maxLinksPerEmail = 20
		maxAdds          = 30
	)

	if cfg.Email.IMAPHost == "" || cfg.Email.Username == "" {
		return types.ScrapeResult{}, errors.New("email enabled but missing imap_host/username")
	}
	pw, _ := secrets.GetIMAPPassword(cfg.Email.PasswordKeyringAccount, cfg.Email.PasswordEnv)
	if pw == "" {
		return types.ScrapeResult{}, errors.New("missing email.app_password (gmail requires an app password with 2FA)")
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

	c, err := DialAndLoginIMAP(ctx, addr, cfg.Email.Username, pw, GmailTLSConfig())
	if err != nil {
		return types.ScrapeResult{}, err
	}
	//defer LogoutAndClose(c)

	if _, err := c.Select(mailbox, &imap.SelectOptions{ReadOnly: false}).Wait(); err != nil {
		return types.ScrapeResult{}, fmt.Errorf("imap select %q: %w", mailbox, err)
	}

	msgs, err := FetchUnseen(ctx, c, maxEmails)
	if err != nil {
		LogoutAndClose(c)

		return types.ScrapeResult{}, err
	}
	if len(msgs) == 0 {
		LogoutAndClose(c)
		return types.ScrapeResult{Source: "email"}, nil
	}

	var (
		leads     []domain.JobLead
		processed []imap.UID
	)

	for _, m := range msgs {
		//log.Printf("[email] found email")
		receivedAt := m.Date
		msgID, bodyText, htmlBody, subj := util.ParseRFC822(m.RawMessage, m.Subject)
		subj = util.DecodeRFC2047(subj)

		// Require subject match when search_subject_any is set
		if len(cfg.Email.SearchSubjectAny) > 0 && !util.ContainsAnyCI(subj, cfg.Email.SearchSubjectAny) {
			processed = append(processed, m.UID)
			continue
		}
		if looksLikeLinkedInJobAlert(m.From, subj, bodyText) {
			//log.Printf("[email] found LinkedIn Job Alert")
			liJobs, perr := ParseLinkedInJobAlertHTML(htmlBody)
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
						sid = util.MakeSourceID(msgID, lj.URL, subj, m.From)
					}

					leads = append(leads, domain.JobLead{
						CompanyName:     lj.Company,
						Title:           lj.Title,
						URL:             lj.URL,
						LocationRaw:     lj.Location,
						WorkMode:        inferWorkMode(lj.Location, subj),
						Description:     desc,
						PostedAt:        &receivedAt,
						FirstSeenSource: "email",
					})
					//log.Printf("[email] Job Alert prepared to be added")
				}

				processed = append(processed, m.UID)
				continue
			}
		}

		processed = append(processed, m.UID)
	}

	if len(processed) > 0 {
		if err := MarkSeen(c, processed); err != nil {
			if !isClosedConnErr(err) {
				log.Printf("[email] mark seen: %v", err)
			}
			// don't fail the whole fetch
		}
	}
	LogoutAndClose(c)

	log.Printf("[email] Process Complete!")

	return types.ScrapeResult{
		Source: "email",
		Leads:  leads,
	}, nil
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
