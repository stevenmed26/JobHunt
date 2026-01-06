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
	"log"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/mail"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"

	"jobhunt-engine/internal/config"

	"github.com/emersion/go-imap/v2"
)

// RunEmailScrapeOnce is the entrypoint your main.go calls.
// It fetches UNSEEN mail, extracts likely job URLs, inserts into SQLite (deduped by source_id),
// and marks processed emails as \Seen.
func RunEmailScrapeOnce(db *sql.DB, cfg config.Config, onNewJob func()) (added int, err error) {
	maxEmails := 20
	maxLinksPerEmail := 10
	maxAdds := 20

	if db == nil {
		return 0, errors.New("db is nil")
	}
	if !cfg.Email.Enabled {
		return 0, nil
	}
	if cfg.Email.IMAPHost == "" || cfg.Email.Username == "" {
		return 0, errors.New("email enabled but missing imap_host/username")
	}

	pass := cfg.Email.AppPassword
	if pass == "" {
		return 0, errors.New("missing email.app_password (Gmail requires an app password with 2FA)")
	}

	addr := cfg.Email.IMAPHost
	if cfg.Email.IMAPPort != 0 && !strings.Contains(addr, ":") {
		addr = fmt.Sprintf("%s:%d", addr, cfg.Email.IMAPPort)
	} else if !strings.Contains(addr, ":") {
		// sensible default
		addr = addr + ":993"
	}

	mailbox := cfg.Email.Mailbox
	if mailbox == "" {
		mailbox = "INBOX"
	}

	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()

	c, err := DialAndLoginIMAP(ctx, addr, cfg.Email.Username, pass, GmailTLSConfig())
	if err != nil {
		return 0, err
	}
	defer LogoutAndClose(c)

	// select configured mailbox
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
		msgID, bodyText, subject := parseRFC822(m.RawMessage, m.Subject)
		subject = decodeRFC2047(subject)
		m.Subject = decodeRFC2047(m.Subject)

		if len(cfg.Email.SearchSubjectAny) > 0 && !containsAnyCI(subject, cfg.Email.SearchSubjectAny) {
			processed = append(processed, m.UID)
			continue
		}

		urls, ctxTextByURL := extractLinksFromBody(bodyText)
		urls = filterJobishURLs(urls)
		if len(urls) > maxLinksPerEmail {
			urls = urls[:maxLinksPerEmail]
		}
		if len(urls) == 0 {
			processed = append(processed, m.UID)
			continue
		}

		for _, u := range urls {
			canonURL := canonicalizeURL(u)

			sid := makeSourceID(msgID, canonURL, subject, m.From)
			if sid == "" {
				continue
			}

			company, title, location, workMode := parseFromSubject(subject)

			if ctxText := ctxTextByURL[canonURL]; ctxText != "" {
				if c2, t2, l2, w2 := parseFromContextText(ctxText); t2 != "" {
					if company == "" {
						company = c2
					}
					if title == "" {
						title = t2
					}
					if location == "" {
						location = l2
					}
					if workMode == "" {
						workMode = w2
					}
				}
			}

			if company == "" {
				company = guessCompanyFromFrom(m.From)
			}
			if title == "" {
				title = decodeRFC2047(subject)
			}
			if location == "" {
				location = "unknown"
			}
			if workMode == "" {
				workMode = "unknown"
			}

			if !shouldInsertJob(company, title, canonURL) {
				continue
			}

			j := jobRow{
				Company:   company,
				Title:     title,
				Location:  location,
				WorkMode:  workMode,
				URL:       canonURL,
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

	if len(processed) > 0 {
		if err := MarkSeen(c, processed); err != nil {
			return added, fmt.Errorf("mark seen: %w", err)
		}
	}

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

// insertJobIfNew inserts a job if its source_id is new. Returns true if inserted.
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

// ---- RFC822 helpers ----

func parseRFC822(raw []byte, fallbackSubject string) (messageID string, bodyText string, subject string) {
	if len(raw) == 0 {
		return "", "", fallbackSubject
	}

	msg, err := mail.ReadMessage(strings.NewReader(string(raw)))
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

	// Read the raw body (may be multipart)
	bodyRaw, _ := io.ReadAll(io.LimitReader(msg.Body, 5<<20)) // 5MB safety limit

	plain, htmlPart := extractMIMETextParts(msg.Header, bodyRaw)

	// Prefer HTML part for link extraction; fallback to plain.
	// Also keep plain appended so regex can catch naked URLs.
	if htmlPart != "" {
		bodyText = htmlPart + "\n" + plain
	} else {
		bodyText = plain
	}

	// If both empty, at least return something.
	if bodyText == "" {
		bodyText = string(bodyRaw)
	}

	return messageID, bodyText, subject
}

func extractMIMETextParts(h mail.Header, body []byte) (plain string, htmlPart string) {
	ct := h.Get("Content-Type")
	cte := strings.ToLower(strings.TrimSpace(h.Get("Content-Transfer-Encoding")))

	mediaType, params, err := mime.ParseMediaType(ct)
	if err != nil {
		// Not parseable; treat as single-part
		s := decodeTransferEncoding(body, cte)
		return string(s), ""
	}

	mediaType = strings.ToLower(mediaType)

	// Multipart: walk parts
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
			partCT := p.Header.Get("Content-Type")
			partCTE := strings.ToLower(strings.TrimSpace(p.Header.Get("Content-Transfer-Encoding")))

			pMedia, _, _ := mime.ParseMediaType(partCT)
			pMedia = strings.ToLower(pMedia)

			b, _ := io.ReadAll(io.LimitReader(p, 3<<20))
			b = decodeTransferEncoding(b, partCTE)

			// Nested multipart (rare but happens)
			if strings.HasPrefix(pMedia, "multipart/") {
				pl, ht := extractMIMETextParts(mail.Header(p.Header), b)
				if len(ht) > len(bestHTML) {
					bestHTML = ht
				}
				if len(pl) > len(bestPlain) {
					bestPlain = pl
				}
				continue
			}

			switch {
			case strings.HasPrefix(pMedia, "text/html"):
				if len(b) > len(bestHTML) {
					bestHTML = string(b)
				}
			case strings.HasPrefix(pMedia, "text/plain"):
				if len(b) > len(bestPlain) {
					bestPlain = string(b)
				}
			}
		}

		return bestPlain, bestHTML
	}

	// Single-part
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
		out, _ := io.ReadAll(io.LimitReader(dec, 5<<20))
		return out
	case "quoted-printable":
		dec := quotedprintable.NewReader(bytes.NewReader(b))
		out, _ := io.ReadAll(io.LimitReader(dec, 5<<20))
		return out
	default:
		return b
	}
}

// ---- URL extraction ----

func extractURLs(s string) []string {
	re := regexp.MustCompile(`https?://[^\s<>"']+`)
	matches := re.FindAllString(s, -1)
	if len(matches) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(matches))
	out := make([]string, 0, len(matches))
	for _, u := range matches {
		u = strings.TrimRight(u, ".,);:]\"'")
		if _, ok := seen[u]; ok {
			continue
		}
		seen[u] = struct{}{}
		out = append(out, u)
	}
	return out
}

func filterJobishURLs(urls []string) []string {
	if len(urls) == 0 {
		return nil
	}

	denySubstrings := []string{
		"unsubscribe",
		"email-preferences",
		"preferences",
		"manage-preferences",
		"privacy",
		"terms",
		"view-in-browser",
		"viewaswebpage",
		"browser",
		"tracking",
		"pixel",
		"beacon",
		"doubleclick",
		"utm_",
		"mc_cid",
		"mc_eid",
		"mandrillapp",
		"sendgrid",
		"mailchimp",
		"list-manage",
		"click.",
		"lnkd.in", // shortener often used in junky digest emails
		"goo.gl",
		"t.co",
		"linkedin.com/comm/jobs/alerts",
		"linkedin.com/jobs/alerts",
		"linkedin.com/comm/jobs/settings",
		"linkedin.com/jobs/settings",
		"linkedin.com/comm/notifications",
		"linkedin.com/help",
		"linkedin.com/legal",
	}

	allowHints := []string{
		"/jobs/",
		"/job/",
		"/career",
		"/careers",
		"greenhouse.io",
		"lever.co",
		"myworkdayjobs.com",
		"workday",
		"icims.com",
		"smartrecruiters.com",
		"ashbyhq.com",
		"breezy.hr",
		"jobvite.com",
		"applytojob.com",
	}

	seen := map[string]struct{}{}
	out := make([]string, 0, len(urls))

	for _, u := range urls {
		lu := strings.ToLower(u)

		// deny obvious junk
		junk := false
		for _, d := range denySubstrings {
			if strings.Contains(lu, d) {
				junk = true
				break
			}
		}
		if junk {
			continue
		}

		// allow only if it smells like a posting/apply page
		ok := false
		for _, a := range allowHints {
			if strings.Contains(lu, a) {
				ok = true
				break
			}
		}
		if !ok {
			continue
		}

		canon := canonicalizeURL(u)
		key := strings.ToLower(canon)

		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, canon)

		// cap per email so one digest doesn’t flood your UI
		if len(out) >= 10 {
			break
		}
	}

	return out
}

// ---- Dedupe key ----

func makeSourceID(messageID, urlStr, subject, from string) string {
	nurl := canonicalizeURL(urlStr)

	if isLinkedInSearchURL(nurl) {
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

func isLinkedInSearchURL(canon string) bool {
	u, err := url.Parse(canon)
	if err != nil {
		return false
	}
	if !strings.Contains(u.Host, "linkedin.com") {
		return false
	}
	p := strings.ToLower(u.Path)
	if strings.Contains(p, "/jobs/view/") {
		return false // allow
	}
	return strings.Contains(p, "/jobs/search") || strings.Contains(p, "/comm/jobs/search")
}

func hashString(s string) string {
	sum := sha1.Sum([]byte(s))
	return hex.EncodeToString(sum[:])
}

// ---- Heuristics ----

func guessCompanyFromFrom(from string) string {
	from = strings.TrimSpace(from)
	if from == "" {
		return "Unknown"
	}
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
			// strings.Title is deprecated; keep simple
			return strings.ToUpper(parts[0][:1]) + parts[0][1:]
		}
	}
	return "Unknown"
}

func guessTitleFromSubject(subject string) string {
	s := strings.TrimSpace(subject)
	if s == "" {
		return "Job Posting"
	}
	for _, p := range []string{"Fwd:", "FW:", "Re:", "RE:"} {
		if strings.HasPrefix(strings.ToLower(s), strings.ToLower(p)) {
			s = strings.TrimSpace(s[len(p):])
		}
	}
	if len(s) > 120 {
		s = s[:120]
	}
	return s
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

func normalizeURL(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return raw
	}

	// drop fragments
	parsed.Fragment = ""

	q := parsed.Query()
	for k := range q {
		lk := strings.ToLower(k)
		if strings.HasPrefix(lk, "utm_") ||
			lk == "mc_cid" || lk == "mc_eid" ||
			lk == "gclid" || lk == "fbclid" ||
			lk == "mkt_tok" {
			q.Del(k)
		}
	}
	parsed.RawQuery = q.Encode()
	return parsed.String()
}

func canonicalizeURL(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return strings.TrimSpace(raw)
	}

	// Lowercase scheme/host for stability
	u.Scheme = strings.ToLower(u.Scheme)
	u.Host = strings.ToLower(u.Host)

	// Drop fragment
	u.Fragment = ""

	// Remove common tracking params and also common junk params
	q := u.Query()
	for k := range q {
		lk := strings.ToLower(k)
		if strings.HasPrefix(lk, "utm_") ||
			lk == "gclid" || lk == "fbclid" || lk == "msclkid" ||
			lk == "mc_cid" || lk == "mc_eid" ||
			lk == "mkt_tok" ||
			lk == "trk" || lk == "trkinfo" ||
			lk == "refid" || lk == "ref" || lk == "src" || lk == "source" {
			q.Del(k)
		}
	}

	// LinkedIn is particularly noisy — keep only what matters
	if strings.Contains(u.Host, "linkedin.com") {
		// LinkedIn job postings typically look like /jobs/view/<id>/
		// For search/comm links, they’re basically not a stable posting.
		// Keep only the path and (optionally) the "currentJobId" param if present.
		keep := url.Values{}
		if v := q.Get("currentJobId"); v != "" {
			keep.Set("currentJobId", v)
		}
		q = keep
	}

	// Sort query params for stable encoding
	if len(q) > 0 {
		// url.Values.Encode() already sorts keys, but not values deterministically if multiple;
		// We’ll force deterministic order for multi-values.
		for k := range q {
			vals := q[k]
			sort.Strings(vals)
			q[k] = vals
		}
		u.RawQuery = q.Encode()
	} else {
		u.RawQuery = ""
	}
	canon := u.String()
	canon = canonicalizeLinkedIn(canon)

	return canon
}

var (
	// Matches:
	//   “software engineer”: Centro - Software Engineer - Remote and more
	// Captures:
	//   kw="software engineer" company="Centro" title="Software Engineer" tail="Remote and more"
	reQuotedKwCompanyTitleTail = regexp.MustCompile(`^[“"](.*?)[”"]:\s*(.*?)\s*-\s*(.*?)\s*-\s*(.*)$`)

	// Matches:
	//   Christus Health and others are hiring for Data Analytics Engineer II - IM Enterprise Data in and around Irving, TX
	// Captures:
	//   company="Christus Health" title="Data Analytics Engineer II - IM Enterprise Data" location="Irving, TX"
	reHiringForInAround = regexp.MustCompile(`^(.*?)\s+and\s+others\s+are\s+hiring\s+for\s+(.*?)\s+in\s+(?:and\s+around\s+)?(.*)$`)

	// Matches:
	//   Company is hiring for Title in Location
	// Captures:
	//   company, title, location
	reHiringForIn = regexp.MustCompile(`^(.*?)\s+is\s+hiring\s+for\s+(.*?)\s+in\s+(.*)$`)

	// Matches:
	//   Company - Title - Location
	reCompanyTitleLocationDash = regexp.MustCompile(`^(.*?)\s*-\s*(.*?)\s*-\s*(.*)$`)

	// Location like "Irving, TX", "Dallas, TX", "United States"
	reCityState = regexp.MustCompile(`(?i)\b([A-Z][a-zA-Z.\- ]+),\s*([A-Z]{2})\b`)
)

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

// parseFromSubject tries to pull company/title/location/workmode from the subject line.
func parseFromSubject(rawSubject string) (company, title, location, workMode string) {
	subj := decodeRFC2047(rawSubject)
	subj = strings.TrimSpace(subj)
	if subj == "" {
		return "", "", "", ""
	}

	// Pattern 1: “kw”: Company - Title - Remote and more
	if m := reQuotedKwCompanyTitleTail.FindStringSubmatch(subj); len(m) == 5 {
		company = strings.TrimSpace(m[2])
		title = strings.TrimSpace(m[3])
		tail := strings.TrimSpace(m[4])

		workMode, location = parseTailForWorkModeAndLocation(tail, subj)
		return company, title, location, workMode
	}

	// Pattern 2: X and others are hiring for Y in and around Z
	if m := reHiringForInAround.FindStringSubmatch(subj); len(m) == 4 {
		company = strings.TrimSpace(m[1])
		title = strings.TrimSpace(m[2])
		location = strings.TrimSpace(m[3])
		workMode = inferWorkMode(location, subj)
		location = cleanLocation(location)
		return company, title, location, workMode
	}

	// Pattern 3: X is hiring for Y in Z
	if m := reHiringForIn.FindStringSubmatch(subj); len(m) == 4 {
		company = strings.TrimSpace(m[1])
		title = strings.TrimSpace(m[2])
		location = strings.TrimSpace(m[3])
		workMode = inferWorkMode(location, subj)
		location = cleanLocation(location)
		return company, title, location, workMode
	}

	// Pattern 4: Company - Title - Location
	if m := reCompanyTitleLocationDash.FindStringSubmatch(subj); len(m) == 4 {
		company = strings.TrimSpace(m[1])
		title = strings.TrimSpace(m[2])
		location = strings.TrimSpace(m[3])
		workMode = inferWorkMode(location, subj)
		location = cleanLocation(location)
		return company, title, location, workMode
	}

	// Fallback: no company/location, keep title = subject
	return "", subj, "", inferWorkMode("", subj)
}

func parseTailForWorkModeAndLocation(tail, fullSubject string) (workMode, location string) {
	// Tail examples: "Remote and more", "Remote", "Dallas-Fort Worth, TX and more", "Hybrid and more"
	t := strings.TrimSpace(strings.TrimSuffix(tail, "and more"))
	t = strings.TrimSpace(strings.TrimSuffix(t, "and More"))

	workMode = inferWorkMode(t, fullSubject)

	// If it looks like a city/state or DFW etc, store as location
	location = cleanLocation(t)
	return workMode, location
}

func inferWorkMode(locationHint, subject string) string {
	s := strings.ToLower(subject + " " + locationHint)
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

func cleanLocation(loc string) string {
	loc = strings.TrimSpace(loc)
	loc = strings.TrimSuffix(loc, ".")
	loc = strings.TrimSuffix(loc, ",")
	loc = strings.TrimSpace(loc)

	// If it's literally "Remote", don't treat as a geographic location.
	if strings.EqualFold(loc, "remote") || strings.EqualFold(loc, "hybrid") || strings.EqualFold(loc, "on-site") || strings.EqualFold(loc, "onsite") {
		return ""
	}

	// If it contains "and more", strip it
	loc = strings.TrimSpace(strings.TrimSuffix(strings.ToLower(loc), "and more"))
	loc = strings.TrimSpace(loc)

	return loc
}

var (
	reHref = regexp.MustCompile(`(?is)<a[^>]+href=["']([^"'#]+)["'][^>]*>(.*?)</a>`)
	reTags = regexp.MustCompile(`(?is)<[^>]+>`)
)

func extractLinksFromBody(body string) (urls []string, contexts map[string]string) {
	contexts = make(map[string]string)

	// Build a “text version” too (helps naked URL regex if HTML is present)
	textVersion := body
	if strings.Contains(strings.ToLower(body), "<html") || strings.Contains(strings.ToLower(body), "<a ") {
		textVersion = htmlToText(body)

		matches := reHref.FindAllStringSubmatch(body, -1)
		for _, m := range matches {
			href := strings.TrimSpace(html.UnescapeString(m[1]))
			txt := strings.TrimSpace(reTags.ReplaceAllString(m[2], " "))
			txt = strings.Join(strings.Fields(html.UnescapeString(txt)), " ")
			ltxt := strings.ToLower(txt)
			if ltxt == "manage alerts" ||
				strings.Contains(ltxt, "manage job alerts") ||
				strings.Contains(ltxt, "job alerts") ||
				strings.Contains(ltxt, "unsubscribe") ||
				strings.Contains(ltxt, "privacy") ||
				strings.Contains(ltxt, "terms") {
				continue
			}
			if href == "" {
				continue
			}

			// Use canonical URL as key so it survives trimming/normalization
			key := canonicalizeURL(href)
			urls = append(urls, href)

			if len(txt) > len(contexts[key]) {
				contexts[key] = txt
			}
		}
	}

	// Naked URLs from text version (not raw HTML)
	naked := extractURLs(textVersion)
	urls = append(urls, naked...)

	// Dedup by canonical URL (not raw)
	seen := map[string]struct{}{}
	out := make([]string, 0, len(urls))
	for _, u := range urls {
		u = strings.TrimSpace(u)
		u = strings.TrimRight(u, ".,);:]\"'")
		if u == "" {
			continue
		}
		key := canonicalizeURL(u)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, u)
	}

	return out, contexts
}

func htmlToText(s string) string {
	// very light conversion: strip tags, unescape, collapse whitespace
	s = reTags.ReplaceAllString(s, " ")
	s = html.UnescapeString(s)
	s = strings.Join(strings.Fields(s), " ")
	return s
}

func parseFromContextText(s string) (company, title, location, workMode string) {
	// common separators
	parts := splitAny(s, []string{" · ", " • ", " - ", " | "})
	// heuristic: title usually first, company often second, location sometimes last
	if len(parts) >= 1 {
		title = strings.TrimSpace(parts[0])
	}
	if len(parts) >= 2 {
		company = strings.TrimSpace(parts[1])
	}
	if len(parts) >= 3 {
		location = cleanLocation(strings.TrimSpace(parts[2]))
		workMode = inferWorkMode(location, s)
	}
	return company, title, location, workMode
}

func splitAny(s string, seps []string) []string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	for _, sep := range seps {
		if strings.Contains(s, sep) {
			raw := strings.Split(s, sep)
			out := make([]string, 0, len(raw))
			for _, p := range raw {
				p = strings.TrimSpace(p)
				if p != "" {
					out = append(out, p)
				}
			}
			return out
		}
	}
	return []string{s}
}

func shouldInsertJob(company, title, urlStr string) bool {
	t := strings.TrimSpace(title)
	c := strings.TrimSpace(company)
	u := strings.TrimSpace(urlStr)

	if u == "" || t == "" {
		return false
	}
	if len(t) < 8 {
		return false
	}

	lt := strings.ToLower(t)
	lc := strings.ToLower(c)

	// reject 1-word titles (common for navbar/footer anchors like "Mobile", "Jobs", "About")
	if len(strings.Fields(t)) < 2 && len(t) < 18 {
		return false
	}

	// reject titles that are mostly non-letters
	letters := 0
	for _, r := range t {
		if (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') {
			letters++
		}
	}
	if letters < 5 {
		return false
	}

	// kill obvious junk
	if lt == "mobile" || lt == "apply" || lt == "view" || lt == "click here" {
		return false
	}
	if lc == "t" || lc == "linkedin" || lc == "linked in" {
		return false
	}

	// url must look like a posting/apply page
	lu := strings.ToLower(u)
	// reject ONLY obvious non-job pages
	if strings.Contains(lu, "/jobs/search") ||
		strings.Contains(lu, "/comm/jobs/search") ||
		strings.Contains(lu, "/alerts") ||
		strings.Contains(lu, "/preferences") {

		log.Printf("[email-scrape] rejected job: title=%q company=%q url=%q", title, company, urlStr)

		return false
	}

	return true
}

var reLinkedInJobView = regexp.MustCompile(`(?i)/jobs/view/(\d+)`)

func canonicalizeLinkedIn(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	if !strings.Contains(strings.ToLower(u.Host), "linkedin.com") {
		return raw
	}

	// If URL path already has /jobs/view/<id>
	if m := reLinkedInJobView.FindStringSubmatch(u.Path); len(m) == 2 {
		return "https://www.linkedin.com/jobs/view/" + m[1]
	}

	// Sometimes it’s a redirect with currentJobId=12345
	q := u.Query()
	if id := q.Get("currentJobId"); id != "" && isDigits(id) {
		return "https://www.linkedin.com/jobs/view/" + id
	}

	return raw
}

func isDigits(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return s != ""
}
