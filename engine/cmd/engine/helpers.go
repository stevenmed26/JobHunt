package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}

func handleLogo(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return
	}

	u := r.URL.Query().Get("u") // already decoded by net/http
	if u == "" {
		http.Error(w, "missing u", http.StatusBadRequest)
		return
	}

	// Gmail proxy URLs sometimes look like:
	// https://ci3.googleusercontent.com/...#https://media.licdn.com/...
	// The part after # is NOT sent in HTTP requests and often points to licdn (403).
	// Always drop the fragment and fetch the actual URL.
	if i := strings.IndexByte(u, '#'); i >= 0 {
		u = strings.TrimSpace(u[:i])
	}

	parsed, err := url.Parse(u)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		http.Error(w, "bad url", http.StatusBadRequest)
		return
	}

	// allowlist
	host := strings.ToLower(parsed.Host)
	allowed := host == "media.licdn.com" ||
		host == "media-exp1.licdn.com" ||
		host == "media-exp2.licdn.com" ||
		strings.HasSuffix(host, ".googleusercontent.com") // Gmail image proxy
	if !allowed {
		http.Error(w, "host not allowed", http.StatusForbidden)
		return
	}

	req, _ := http.NewRequest(http.MethodGet, u, nil)
	req.Header.Set("User-Agent", "Mozilla/5.0")
	req.Header.Set("Accept", "image/avif,image/webp,image/apng,image/*,*/*;q=0.8")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")

	// Only set Referer for LinkedIn CDN; setting it for googleusercontent is unnecessary and can hurt.
	if strings.HasSuffix(host, "licdn.com") {
		req.Header.Set("Referer", "https://www.linkedin.com/")
	}

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("[logo] fetch failed url=%s err=%v", u, err)
		http.Error(w, "fetch failed", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
		log.Printf("[logo] upstream status=%s url=%s body=%q", resp.Status, u, string(b))
		http.Error(w, "upstream status: "+resp.Status, http.StatusBadGateway)
		return
	}

	ct := resp.Header.Get("Content-Type")
	if ct == "" {
		ct = "image/*"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "public, max-age=86400")

	_, _ = io.Copy(w, resp.Body)
}

func deleteJob(ctx context.Context, db *sql.DB, id int64) error {
	_, err := db.ExecContext(ctx, `DELETE FROM jobs WHERE id = ?;`, id)
	return err
}

func randomToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func shutdownHandler(token *string, srv *http.Server) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}

		// Local-only guard (covers typical desktop usage)
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			// RemoteAddr can sometimes be just a host; fall back safely
			host = r.RemoteAddr
		}
		if host != "127.0.0.1" && host != "::1" && host != "localhost" {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}

		// Token guard
		got := r.Header.Get("X-Shutdown-Token")
		if got == "" || subtle.ConstantTimeCompare([]byte(got), []byte(*token)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		// Respond immediately, then shutdown asynchronously
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("shutting down\n"))

		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = srv.Shutdown(ctx)
		}()
	}
}
