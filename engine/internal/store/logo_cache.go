package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"
)

func LogoKeyFromURL(u string) string {
	h := sha256.Sum256([]byte(u))
	return hex.EncodeToString(h[:])
}

func CacheLogoFromURL(ctx context.Context, db *sql.DB, raw string) (key string, err error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil
	}

	if i := strings.IndexByte(raw, '#'); i >= 0 {
		raw = strings.TrimSpace(raw[:i]) // keep only proxy
	}
	if strings.Contains(raw, "media.licdn.com") {
		return "", nil // never fetch LinkedIn CDN (403)
	}

	pu, err := url.Parse(raw)
	if err != nil || pu.Scheme == "" || pu.Host == "" {
		return "", nil
	}

	// Optional allowlist (recommended)
	host := strings.ToLower(pu.Host)
	allowed := false

	if host == "www.google.com" || host == "google.com" {
		allowed = true
	}
	if strings.HasSuffix(host, "googleusercontent.com") {
		allowed = true
	}
	if host == "media.licdn.com" || (strings.HasPrefix(host, "media-exp") && strings.HasSuffix(host, ".licdn.com")) {
		allowed = true
	}

	if !allowed {
		return "", nil
	}

	//log.Printf("[logo-cache] fetch url=%s", raw)

	key = LogoKeyFromURL(raw)

	// If already cached, skip fetch
	var exists int
	e := db.QueryRowContext(ctx, `SELECT 1 FROM logos WHERE key = ? LIMIT 1;`, key).Scan(&exists)
	if e == nil {
		return key, nil
	}
	if e != sql.ErrNoRows {
		return "", e
	}

	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	req.Header.Set("User-Agent", "Mozilla/5.0")
	req.Header.Set("Accept", "image/avif,image/webp,image/apng,image/*,*/*;q=0.8")
	req.Header.Set("Referer", "https://www.linkedin.com/")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("[logo-cache] fetch error url=%s err=%v", raw, err)
		return "", nil
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		log.Printf("[logo-cache] non-2xx url=%s status=%s", raw, resp.Status)
		return "", nil
	}

	// Limit size (protect DB)
	const max = 512 * 1024 // 512KB
	b, err := io.ReadAll(io.LimitReader(resp.Body, max+1))
	if err != nil {
		return "", nil
	}
	if len(b) == 0 || len(b) > max {
		return "", nil
	}

	ct := resp.Header.Get("Content-Type")
	if ct == "" || !strings.HasPrefix(ct, "image/") {
		// sniff as fallback
		sn := http.DetectContentType(b)
		if !strings.HasPrefix(sn, "image/") {
			return "", errors.New("not an image")
		}
		ct = sn
	}

	_, err = db.ExecContext(ctx, `
INSERT OR REPLACE INTO logos(key, content_type, bytes, fetched_at)
VALUES(?,?,?,?);`,
		key,
		ct,
		b,
		time.Now().UTC().Format(time.RFC3339),
	)
	if err != nil {
		return "", err
	}

	return key, nil
}

func FaviconURLForDomain(domain string) string {
	domain = strings.TrimSpace(strings.ToLower(domain))
	domain = strings.TrimPrefix(domain, "http://")
	domain = strings.TrimPrefix(domain, "https://")
	domain = strings.TrimPrefix(domain, "www.")
	domain = strings.Trim(domain, "/")
	if domain == "" {
		return ""
	}
	// sz can be 16/32/64/128
	return "https://www.google.com/s2/favicons?domain=" + url.QueryEscape(domain) + "&sz=64"
}

func CacheFaviconForDomain(ctx context.Context, db *sql.DB, domain string) (string, error) {
	u := FaviconURLForDomain(domain)
	if u == "" {
		return "", nil
	}
	return CacheLogoFromURL(ctx, db, u)
}
