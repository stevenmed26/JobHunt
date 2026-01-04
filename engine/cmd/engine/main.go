package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"sync/atomic"

	"jobhunt-engine/internal/config"

	_ "modernc.org/sqlite"
)

type Job struct {
	ID        int64     `json:"id"`
	Company   string    `json:"company"`
	Title     string    `json:"title"`
	Location  string    `json:"location"`
	WorkMode  string    `json:"workMode"`
	URL       string    `json:"url"`
	Score     int       `json:"score"`
	Tags      []string  `json:"tags"`
	FirstSeen time.Time `json:"firstSeen"`
}

type eventHub struct {
	mu      sync.Mutex
	clients map[chan string]struct{}
}

func newHub() *eventHub {
	return &eventHub{clients: make(map[chan string]struct{})}
}

func (h *eventHub) subscribe() chan string {
	ch := make(chan string, 10)
	h.mu.Lock()
	h.clients[ch] = struct{}{}
	h.mu.Unlock()
	return ch
}

func (h *eventHub) unsubscribe(ch chan string) {
	h.mu.Lock()
	delete(h.clients, ch)
	h.mu.Unlock()
	close(ch)
}

func (h *eventHub) publish(evt string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.clients {
		select {
		case ch <- evt:
		default:
			// drop if slow
		}
	}
}

func main() {
	// Engine data dir: use env if provided (Tauri can pass one), else local folder.
	dataDir := os.Getenv("JOBHUNT_DATA_DIR")
	if dataDir == "" {
		dataDir = "."
	}
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		log.Fatal(err)
	}

	defaultCfgPath := filepath.Join("config", "config.yml")
	userCfgPath, err := config.EnsureUserConfig(dataDir, defaultCfgPath)
	if err != nil {
		log.Fatalf("config bootstrap failed: %v", err)
	}

	// Load config and keep it reloadable
	var cfgVal atomic.Value // stores config.Config
	loadCfg := func() (config.Config, error) {
		return config.Load(userCfgPath)
	}
	cfg, err := loadCfg().(config.Config)
	if err != nil {
		log.Fatalf("config load failed (%s): %v", userCfgPath, err)
	}
	cfgVal.Store(cfg)

	dbPath := filepath.Join(dataDir, "jobhunt.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()

	if err := migrate(db); err != nil {
		log.Fatal(err)
	}

	hub := newHub()

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"ok": true, "time": time.Now().Format(time.RFC3339)})
	})
	mux.HandleFunc("/jobs", func(w http.ResponseWriter, r *http.Request) {
		jobs, err := listJobs(r.Context(), db)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		writeJSON(w, jobs)
	})
	mux.HandleFunc("/seed", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", 405)
			return
		}
		job, err := seedJob(r.Context(), db)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		// Emit an SSE event so the UI refreshes instantly.
		hub.publish(`{"type":"job_created","id":` + fmt.Sprint(job.ID) + `}`)
		writeJSON(w, job)
	})
	mux.HandleFunc("/events", func(w http.ResponseWriter, r *http.Request) {
		// Server-Sent Events
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("Access-Control-Allow-Origin", "*") // safe for localhost UI

		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming unsupported", 500)
			return
		}

		ch := hub.subscribe()
		defer hub.unsubscribe(ch)

		// initial ping
		fmt.Fprintf(w, "event: ping\ndata: %s\n\n", `{"type":"ping"}`)
		flusher.Flush()

		for {
			select {
			case <-r.Context().Done():
				return
			case msg := <-ch:
				fmt.Fprintf(w, "event: message\ndata: %s\n\n", msg)
				flusher.Flush()
			}
		}
	})

	// Bind to a predictable local port for now (simpler).
	addr := "127.0.0.1:38471"
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("engine listening on http://%s (db=%s)", addr, dbPath)

	srv := &http.Server{
		Handler:           cors(mux),
		ReadHeaderTimeout: 5 * time.Second,
	}
	log.Fatal(srv.Serve(ln))
}

func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Tauri fetch requests come from "tauri://localhost" origin.
		origin := r.Header.Get("Origin")
		if origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.Header().Set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(204)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func migrate(db *sql.DB) error {
	_, err := db.Exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  location TEXT NOT NULL,
  work_mode TEXT NOT NULL,
  url TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '[]',
  first_seen TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_first_seen ON jobs(first_seen DESC);
`)
	return err
}

func listJobs(ctx context.Context, db *sql.DB) ([]Job, error) {
	rows, err := db.QueryContext(ctx, `
SELECT id, company, title, location, work_mode, url, score, tags, first_seen
FROM jobs
ORDER BY first_seen DESC
LIMIT 200;`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Job
	for rows.Next() {
		var j Job
		var tagsJSON string
		var firstSeenStr string
		if err := rows.Scan(&j.ID, &j.Company, &j.Title, &j.Location, &j.WorkMode, &j.URL, &j.Score, &tagsJSON, &firstSeenStr); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(tagsJSON), &j.Tags)
		j.FirstSeen, _ = time.Parse(time.RFC3339, firstSeenStr)
		out = append(out, j)
	}
	return out, rows.Err()
}

func seedJob(ctx context.Context, db *sql.DB) (Job, error) {
	j := Job{
		Company:   "SeedCo",
		Title:     "SRE / Platform Engineer (DFW or Remote)",
		Location:  "Dallas-Fort Worth, TX",
		WorkMode:  "remote",
		URL:       "https://example.com/apply",
		Score:     88,
		Tags:      []string{"SRE", "Kubernetes", "Terraform", "AWS", "Go"},
		FirstSeen: time.Now().UTC(),
	}
	tagsB, _ := json.Marshal(j.Tags)
	res, err := db.ExecContext(ctx, `
INSERT INTO jobs(company, title, location, work_mode, url, score, tags, first_seen)
VALUES(?,?,?,?,?,?,?,?);`,
		j.Company, j.Title, j.Location, j.WorkMode, j.URL, j.Score, string(tagsB), j.FirstSeen.Format(time.RFC3339))
	if err != nil {
		return Job{}, err
	}
	j.ID, _ = res.LastInsertId()
	return j, nil
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}
