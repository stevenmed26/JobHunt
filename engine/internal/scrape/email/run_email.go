package email_scrape

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"

	//"sort"
	"strings"
	"time"

	"jobhunt-engine/internal/config"
	"jobhunt-engine/internal/domain"
	"jobhunt-engine/internal/rank"

	"github.com/emersion/go-imap/v2"
)

type jobRow struct {
	Company     string
	Title       string
	Location    string
	WorkMode    string
	Description string
	URL         string
	Score       int
	Tags        []string
	ReceivedAt  time.Time
	SourceID    string
}

// RunEmailScrapeOnce scans UNSEEN emails, but ONLY those whose subject matches cfg.Email.SearchSubjectAny.
// It extracts job-ish URLs and inserts rows into jobs (deduped by source_id), then marks emails \Seen.
func RunEmailScrapeOnce(db *sql.DB, cfg config.Config, onNewJob func()) (added int, err error) {
	const (
		maxEmails        = 2000
		maxLinksPerEmail = 200
		maxAdds          = 1000
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

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
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

		receivedAt := m.Date
		msgID, bodyText, htmlBody, subj := parseRFC822(m.RawMessage, m.Subject)
		subj = decodeRFC2047(subj)

		// Require subject match when search_subject_any is set
		if len(cfg.Email.SearchSubjectAny) > 0 && !containsAnyCI(subj, cfg.Email.SearchSubjectAny) {
			processed = append(processed, m.UID)
			continue
		}

		// --- LinkedIn Job Alert special-case
		if looksLikeLinkedInJobAlert(subj, bodyText) {

			liJobs, perr := ParseLinkedInJobAlertHTML(htmlBody)
			log.Printf("[email] LinkedIn parser: found %d jobs, err=%v", len(liJobs), perr)
			if len(liJobs) > 0 {
				log.Printf("[email] sample: title=%q company=%q loc=%q url=%q", liJobs[0].Title, liJobs[0].Company, liJobs[0].Location, liJobs[0].URL)
			}
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
						Company:    lj.Company,
						Title:      lj.Title,
						Location:   lj.Location,
						WorkMode:   inferWorkMode(lj.Location, subj),
						URL:        lj.URL,
						Score:      score,
						Tags:       tags,
						ReceivedAt: receivedAt.Local(),
						SourceID:   sid,
						// Salary:  lj.Salary,
						// LogoURL: lj.LogoURL,
					}

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

		// // Extract URLs + anchor contexts
		// rawURLs, contexts := extractLinksFromBody(bodyText)
		// if len(rawURLs) == 0 {
		// 	processed = append(processed, m.UID)
		// 	continue
		// }

		// // Canonicalize + lightly filter junk
		// cands := make([]string, 0, len(rawURLs))
		// seen := map[string]struct{}{}
		// for _, u := range rawURLs {
		// 	cu := canonicalizeURL(u)
		// 	if cu == "" {
		// 		continue
		// 	}
		// 	key := strings.ToLower(cu)
		// 	if _, ok := seen[key]; ok {
		// 		continue
		// 	}
		// 	seen[key] = struct{}{}
		// 	if isObviousJunkURL(cu) {
		// 		continue
		// 	}
		// 	cands = append(cands, cu)
		// }
		// if len(cands) == 0 {
		// 	processed = append(processed, m.UID)
		// 	continue
		// }

		// // Rank URLs so we prefer job postings/apply pages without being too strict.
		// sort.SliceStable(cands, func(i, j int) bool {
		// 	return scoreURL(cands[i]) > scoreURL(cands[j])
		// })

		// if len(cands) > maxLinksPerEmail {
		// 	cands = cands[:maxLinksPerEmail]
		// }

		// // Basic “job” fields (we’ll keep parsing lightweight for now)
		// company := guessCompanyFromFrom(m.From)
		// title := normalizeSubjectTitle(subj)
		// location := "unknown"
		// workMode := inferWorkMode("", subj)

		// for _, cu := range cands {
		// 	// Build description
		// 	descParts := make([]string, 0, 4)

		// 	// If anchor text exists for this URL, and it looks like a title, use it.
		// 	if ctxText := contexts[cu]; ctxText != "" {
		// 		if looksLikeTitle(ctxText) {
		// 			title = ctxText
		// 		}
		// 		descParts = append(descParts, ctxText) // For now use anchor text as description
		// 	}

		// 	// Subject + sender
		// 	descParts = append(descParts, subj)
		// 	descParts = append(descParts, m.From)

		// 	// Small body excerpt
		// 	if bodyText != "" {
		// 		descParts = append(descParts, clip(bodyText, 2000))
		// 	}

		// 	desc := strings.Join(descParts, "\n")

		// 	sid := makeSourceID(msgID, cu, subj, m.From)
		// 	if sid == "" {
		// 		continue
		// 	}

		// 	lead := domain.JobLead{
		// 		CompanyName:     company,
		// 		Title:           title,
		// 		URL:             cu,
		// 		LocationRaw:     location,
		// 		WorkMode:        workMode,
		// 		ATSJobID:        "",
		// 		ReqID:           "",
		// 		Description:     desc,
		// 		PostedAt:        &receivedAt, // This is not really when the job was posted
		// 		FirstSeenSource: "email",
		// 	}

		// 	score, tags := scorer.Score(lead)

		// 	j := jobRow{
		// 		Company:     company,
		// 		Title:       title,
		// 		Location:    location,
		// 		WorkMode:    workMode,
		// 		Description: desc,
		// 		URL:         cu,
		// 		Score:       score,
		// 		Tags:        tags,
		// 		ReceivedAt:  receivedAt.Local(),
		// 		SourceID:    sid,
		// 	}

		// 	ok, ierr := insertJobIfNew(ctx, db, j)
		// 	if ierr != nil {
		// 		continue
		// 	}
		// 	if ok {
		// 		added++
		// 		if onNewJob != nil {
		// 			onNewJob()
		// 		}
		// 		if added >= maxAdds {
		// 			processed = append(processed, m.UID)
		// 			break runLoop
		// 		}
		// 	}
		// }

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
INSERT OR IGNORE INTO jobs(company, title, location, work_mode, url, score, tags, date, source_id)
VALUES(?,?,?,?,?,?,?,?,?);`,
		j.Company,
		j.Title,
		j.Location,
		j.WorkMode,
		j.URL,
		j.Score,
		string(tagsB),
		j.ReceivedAt.Format(time.RFC3339),
		j.SourceID,
	)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// ---------------- Matching / heuristics ----------------

func containsAnyCI(s string, any []string) bool {
	ls := strings.ToLower(s)
	for _, a := range any {
		a = strings.TrimSpace(a)
		if a == "" {
			continue
		}
		if strings.Contains(ls, strings.ToLower(a)) {
			return true
		}
	}
	return false
}

func normalizeSubjectTitle(subj string) string {
	s := strings.TrimSpace(subj)
	if s == "" {
		return "Job Posting"
	}
	// strip common prefixes
	for _, p := range []string{"fwd:", "fw:", "re:"} {
		if strings.HasPrefix(strings.ToLower(s), p) {
			s = strings.TrimSpace(s[len(p):])
		}
	}
	// avoid absurdly long titles
	if len(s) > 140 {
		s = s[:140]
	}
	return s
}

func looksLikeTitle(s string) bool {
	s = strings.TrimSpace(s)
	if len(s) < 8 {
		return false
	}
	ls := strings.ToLower(s)
	// common nav labels / junk
	if ls == "apply" || ls == "view" || ls == "mobile" || ls == "unsubscribe" {
		return false
	}
	// require some letters
	letters := 0
	for _, r := range s {
		if (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') {
			letters++
		}
	}
	return letters >= 5
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

func guessCompanyFromFrom(from string) string {
	from = strings.TrimSpace(from)
	if from == "" {
		return "Unknown"
	}
	// Try friendly name: Foo Bar <x@y.com>
	if i := strings.Index(from, "<"); i > 0 {
		name := strings.TrimSpace(from[:i])
		name = strings.Trim(name, `"`)
		if name != "" {
			return name
		}
	}
	// fallback: domain
	if at := strings.LastIndex(from, "@"); at >= 0 {
		d := strings.Trim(from[at+1:], "> ")
		parts := strings.Split(d, ".")
		if len(parts) > 0 && parts[0] != "" {
			return strings.ToUpper(parts[0][:1]) + parts[0][1:]
		}
	}
	return "Unknown"
}

// ---------------- Dedupe / URL canonicalization ----------------

func makeSourceID(messageID, urlStr, subject, from string) string {
	nurl := canonicalizeURL(urlStr)
	if nurl == "" {
		return ""
	}
	base := ""
	if messageID != "" {
		base = "mid:" + messageID + "|url:" + nurl
	} else {
		base = "from:" + from + "|sub:" + subject + "|url:" + nurl
	}
	return hashString(base)
}
