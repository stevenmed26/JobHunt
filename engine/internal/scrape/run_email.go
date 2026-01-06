package scrape

import (
	"bytes"
	"context"
	"crypto/sha1"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/mail"
	"regexp"
	"sort"
	"strings"
	"time"

	"jobhunt-engine/internal/config"

	"github.com/emersion/go-imap/v2"
)

// RunEmailScrapeOnce scans UNSEEN emails, but ONLY those whose subject matches cfg.Email.SearchSubjectAny.
// It extracts job-ish URLs and inserts rows into jobs (deduped by source_id), then marks emails \Seen.
func RunEmailScrapeOnce(db *sql.DB, cfg config.Config, onNewJob func()) (added int, err error) {
	const (
		maxEmails        = 30
		maxLinksPerEmail = 10
		maxAdds          = 30
	)

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

	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
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
		msgID, bodyText, subj := parseRFC822(m.RawMessage, m.Subject)
		subj = decodeRFC2047(subj)

		// Require subject match when search_subject_any is set
		if len(cfg.Email.SearchSubjectAny) > 0 && !containsAnyCI(subj, cfg.Email.SearchSubjectAny) {
			processed = append(processed, m.UID)
			continue
		}

		// Extract URLs + anchor contexts
		rawURLs, contexts := extractLinksFromBody(bodyText)
		if len(rawURLs) == 0 {
			processed = append(processed, m.UID)
			continue
		}

		// Canonicalize + lightly filter junk
		cands := make([]string, 0, len(rawURLs))
		seen := map[string]struct{}{}
		for _, u := range rawURLs {
			cu := canonicalizeURL(u)
			if cu == "" {
				continue
			}
			key := strings.ToLower(cu)
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			if isObviousJunkURL(cu) {
				continue
			}
			cands = append(cands, cu)
		}
		if len(cands) == 0 {
			processed = append(processed, m.UID)
			continue
		}

		// Rank URLs so we prefer job postings/apply pages without being too strict.
		sort.SliceStable(cands, func(i, j int) bool {
			return scoreURL(cands[i]) > scoreURL(cands[j])
		})

		if len(cands) > maxLinksPerEmail {
			cands = cands[:maxLinksPerEmail]
		}

		// Basic “job” fields (we’ll keep parsing lightweight for now)
		company := guessCompanyFromFrom(m.From)
		title := normalizeSubjectTitle(subj)
		location := "unknown"
		workMode := inferWorkMode("", subj)

		for _, cu := range cands {
			// If anchor text exists for this URL, and it looks like a title, use it.
			if ctxText := contexts[cu]; ctxText != "" {
				if looksLikeTitle(ctxText) {
					title = ctxText
				}
			}

			sid := makeSourceID(msgID, cu, subj, m.From)
			if sid == "" {
				continue
			}

			j := jobRow{
				Company:   company,
				Title:     title,
				Location:  location,
				WorkMode:  workMode,
				URL:       cu,
				Score:     0,
				Tags:      []string{},
				FirstSeen: time.Now().UTC(),
				SourceID:  sid,
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
	}

	// if len(processed) > 0 {
	// 	if err := MarkSeen(c, processed); err != nil {
	// 		return added, fmt.Errorf("mark seen: %w", err)
	// 	}
	// }

	return added, nil
}

type jobRow struct {
	Company   string
	Title     string
	Location  string
	WorkMode  string
	URL       string
	Score     int
	Tags      []string
	FirstSeen time.Time
	SourceID  string
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
	if j.FirstSeen.IsZero() {
		j.FirstSeen = time.Now().UTC()
	}
	if j.SourceID == "" {
		j.SourceID = hashString("url:" + j.URL)
	}

	tagsB, _ := json.Marshal(j.Tags)

	res, err := db.ExecContext(ctx, `
INSERT OR IGNORE INTO jobs(company, title, location, work_mode, url, score, tags, first_seen, source_id)
VALUES(?,?,?,?,?,?,?,?,?);`,
		j.Company,
		j.Title,
		j.Location,
		j.WorkMode,
		j.URL,
		j.Score,
		string(tagsB),
		j.FirstSeen.Format(time.RFC3339),
		j.SourceID,
	)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// ---------------- RFC822 / MIME ----------------

func parseRFC822(raw []byte, fallbackSubject string) (messageID, bodyText, subject string) {
	if len(raw) == 0 {
		return "", "", fallbackSubject
	}

	msg, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		return "", string(raw), fallbackSubject
	}

	messageID = strings.TrimSpace(msg.Header.Get("Message-Id"))
	if messageID == "" {
		messageID = strings.TrimSpace(msg.Header.Get("Message-ID"))
	}

	subject = strings.TrimSpace(msg.Header.Get("Subject"))
	if subject == "" {
		subject = fallbackSubject
	}

	bodyRaw, _ := io.ReadAll(io.LimitReader(msg.Body, 6<<20)) // 6MB cap
	plain, htmlPart := extractMIMETextParts(msg.Header, bodyRaw)

	if htmlPart != "" {
		bodyText = htmlPart + "\n" + plain
	} else {
		bodyText = plain
	}
	if bodyText == "" {
		bodyText = string(bodyRaw)
	}
	return messageID, bodyText, subject
}

func extractMIMETextParts(h mail.Header, body []byte) (plain, htmlPart string) {
	ct := h.Get("Content-Type")
	cte := strings.ToLower(strings.TrimSpace(h.Get("Content-Transfer-Encoding")))

	mediaType, params, err := mime.ParseMediaType(ct)
	if err != nil {
		s := decodeTransferEncoding(body, cte)
		return string(s), ""
	}
	mediaType = strings.ToLower(mediaType)

	if strings.HasPrefix(mediaType, "multipart/") {
		boundary := params["boundary"]
		if boundary == "" {
			s := decodeTransferEncoding(body, cte)
			return string(s), ""
		}
		mr := multipart.NewReader(bytes.NewReader(body), boundary)

		var bestPlain, bestHTML string
		for {
			p, err := mr.NextPart()
			if err != nil {
				break
			}
			partCTE := strings.ToLower(strings.TrimSpace(p.Header.Get("Content-Transfer-Encoding")))
			partCT := p.Header.Get("Content-Type")
			pMedia, _, _ := mime.ParseMediaType(partCT)
			pMedia = strings.ToLower(pMedia)

			b, _ := io.ReadAll(io.LimitReader(p, 4<<20))
			b = decodeTransferEncoding(b, partCTE)

			if strings.HasPrefix(pMedia, "multipart/") {
				pl, ht := extractMIMETextParts(mail.Header(p.Header), b)
				if len(pl) > len(bestPlain) {
					bestPlain = pl
				}
				if len(ht) > len(bestHTML) {
					bestHTML = ht
				}
				continue
			}

			switch {
			case strings.HasPrefix(pMedia, "text/plain"):
				if len(b) > len(bestPlain) {
					bestPlain = string(b)
				}
			case strings.HasPrefix(pMedia, "text/html"):
				if len(b) > len(bestHTML) {
					bestHTML = string(b)
				}
			}
		}
		return bestPlain, bestHTML
	}

	s := decodeTransferEncoding(body, cte)
	if strings.HasPrefix(mediaType, "text/html") {
		return "", string(s)
	}
	return string(s), ""
}

func decodeTransferEncoding(b []byte, cte string) []byte {
	switch cte {
	case "base64":
		dec := base64.NewDecoder(base64.StdEncoding, bytes.NewReader(b))
		out, _ := io.ReadAll(io.LimitReader(dec, 6<<20))
		return out
	case "quoted-printable":
		dec := quotedprintable.NewReader(bytes.NewReader(b))
		out, _ := io.ReadAll(io.LimitReader(dec, 6<<20))
		return out
	default:
		return b
	}
}

// ---------------- Link extraction ----------------

var (
	reHref = regexp.MustCompile(`(?is)<a[^>]+href=["']([^"'#]+)["'][^>]*>(.*?)</a>`)
	reTags = regexp.MustCompile(`(?is)<[^>]+>`)
	reURL  = regexp.MustCompile(`https?://[^\s<>"']+`)
)

func extractLinksFromBody(body string) (urls []string, contexts map[string]string) {
	contexts = make(map[string]string)

	lower := strings.ToLower(body)
	textVersion := body

	// Prefer anchors if HTML-ish
	if strings.Contains(lower, "<html") || strings.Contains(lower, "<a ") {
		textVersion = htmlToText(body)

		matches := reHref.FindAllStringSubmatch(body, -1)
		for _, m := range matches {
			href := strings.TrimSpace(html.UnescapeString(m[1]))
			txt := strings.TrimSpace(reTags.ReplaceAllString(m[2], " "))
			txt = strings.Join(strings.Fields(html.UnescapeString(txt)), " ")

			if href == "" {
				continue
			}

			cu := canonicalizeURL(href)
			urls = append(urls, href)

			// store best (longest) context text for this canonical URL
			if len(txt) > len(contexts[cu]) {
				contexts[cu] = txt
			}
		}
	}

	// Naked URLs from text (not raw HTML)
	for _, u := range reURL.FindAllString(textVersion, -1) {
		urls = append(urls, strings.TrimRight(u, ".,);:]\"'"))
	}

	return urls, contexts
}

func htmlToText(s string) string {
	s = reTags.ReplaceAllString(s, " ")
	s = html.UnescapeString(s)
	return strings.Join(strings.Fields(s), " ")
}

// ---------------- Matching / heuristics ----------------

func decodeRFC2047(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return s
	}
	dec := new(mime.WordDecoder)
	out, err := dec.DecodeHeader(s)
	if err != nil {
		return s
	}
	return out
}

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

func hashString(s string) string {
	sum := sha1.Sum([]byte(s))
	return hex.EncodeToString(sum[:])
}
