package email_scrape

import (
	"bytes"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"html"
	"io"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/mail"
	"regexp"
	"strings"
)

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

func parseRFC822(raw []byte, fallbackSubject string) (messageID, bodyText, htmlBody, subject string) {
	if len(raw) == 0 {
		return "", "", "", fallbackSubject
	}

	msg, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		// If parsing fails, treat raw as plaintext best-effort
		return "", string(raw), "", fallbackSubject
	}

	messageID = strings.TrimSpace(msg.Header.Get("Message-Id"))
	if messageID == "" {
		messageID = strings.TrimSpace(msg.Header.Get("Message-ID"))
	}

	subject = strings.TrimSpace(msg.Header.Get("Subject"))
	if subject == "" {
		subject = fallbackSubject
	}

	bodyRaw, _ := io.ReadAll(io.LimitReader(msg.Body, 25<<20)) // 6MB cap

	plain, htmlPart := extractMIMETextParts(msg.Header, bodyRaw)

	bodyText = plain
	htmlBody = htmlPart

	// Fallbacks if MIME parsing didn't find anything
	if bodyText == "" && htmlBody == "" {
		bodyText = string(bodyRaw)
	}

	return messageID, bodyText, htmlBody, subject
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

			b, _ := io.ReadAll(io.LimitReader(p, 20<<20))
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

func htmlToText(s string) string {
	s = reTags.ReplaceAllString(s, " ")
	s = html.UnescapeString(s)
	return strings.Join(strings.Fields(s), " ")
}

func hashString(s string) string {
	sum := sha1.Sum([]byte(s))
	return hex.EncodeToString(sum[:])
}

func clip(s string, max int) string {
	s = strings.TrimSpace(s)
	if max <= 0 || len(s) <= max {
		return s
	}
	return s[:max]
}
