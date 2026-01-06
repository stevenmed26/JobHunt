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
	"strconv"
	"strings"
	"sync"
	"time"

	"sync/atomic"

	"jobhunt-engine/internal/config"
	"jobhunt-engine/internal/scrape"

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

type ScrapeStatus struct {
	LastRunAt string `json:"last_run_at"`
	LastOkAt  string `json:"last_ok_at"`
	LastError string `json:"last_error"`
	LastAdded int    `json:"last_added"`
	Running   bool   `json:"running"`
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
	dataDir := os.Getenv("JOBHUNT_DATA_DIR")
	if dataDir == "" {
		dataDir = "."
	}
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		log.Fatal(err)
	}

	lockPath := filepath.Join(dataDir, "engine.lock")
	lockFile, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		log.Fatalf("engine is already running (lock exists): %s", lockPath)
	}
	defer func() {
		lockFile.Close()
		_ = os.Remove(lockPath)
	}()

	userCfgPath, err := config.EnsureUserConfig(dataDir)
	if err != nil {
		log.Fatalf("config bootstrap failed: %v", err)
	}
	// Load config and keep it reloadable
	var cfgVal atomic.Value // stores config.Config
	loadCfg := func() (config.Config, error) {
		return config.Load(userCfgPath)
	}
	cfg, err := loadCfg()
	if err != nil {
		log.Fatalf("config load failed (%s): %v", userCfgPath, err)
	}
	cfgVal.Store(cfg)

	// Load scrape status
	var scrapeStatus atomic.Value // stores ScrapeStatus
	scrapeStatus.Store(ScrapeStatus{})

	// scorer := func(job domain.JobLead) (int, []string) {
	// 	c := cfgVal.Load().(config.Config)
	// 	return rank.YAMLScorer{Cfg: c}.Score(job)
	// }

	dbPath := filepath.Join(dataDir, "jobhunt.db")
	db, err := sql.Open("sqlite", dbPath)
	if _, err := db.Exec(`PRAGMA journal_mode=WAL;`); err != nil {
		log.Printf("WARN: set WAL: %v", err)
	}
	if _, err := db.Exec(`PRAGMA busy_timeout=5000;`); err != nil {
		log.Printf("WARN: set busy_timeout: %v", err)
	}
	if _, err := db.Exec(`PRAGMA synchronous=NORMAL;`); err != nil {
		log.Printf("WARN: set synchronous: %v", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()

	if err := migrate(db); err != nil {
		log.Fatal(err)
	}

	hub := newHub()

	startEmailPoller(db, &cfgVal, &scrapeStatus, hub)

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
	mux.HandleFunc("/jobs/", func(w http.ResponseWriter, r *http.Request) {
		// expects /jobs/{id}
		if r.Method != http.MethodDelete {
			http.Error(w, "DELETE only", 405)
			return
		}

		idStr := strings.TrimPrefix(r.URL.Path, "/jobs/")
		id, err := strconv.ParseInt(idStr, 10, 64)
		if err != nil || id <= 0 {
			http.Error(w, "invalid id", 400)
			return
		}

		if err := deleteJob(r.Context(), db, id); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}

		// Optional: notify UI via SSE so it refreshes
		hub.publish(`{"type":"job_deleted","id":` + fmt.Sprint(id) + `}`)

		writeJSON(w, map[string]any{"ok": true, "id": id})
	})

	mux.HandleFunc("/config", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			cur := cfgVal.Load().(config.Config)
			writeJSON(w, cur)
			return
		case http.MethodPut:
			// Temporary debug block
			// b, _ := io.ReadAll(r.Body)
			// log.Printf("PUT /config raw : %s", string(b))

			dec := json.NewDecoder(r.Body)
			dec.DisallowUnknownFields()

			var incoming config.Config
			if err := dec.Decode(&incoming); err != nil {
				http.Error(w, "invalid JSON: "+err.Error(), 400)
				return
			}
			if dec.More() {
				http.Error(w, "invalid JSON: trailing data", 400)
				return
			}

			// log.Printf("decoded incoming app=%+v", incoming.App)
			// log.Printf("decoded incoming port=%d data_dir=%q", incoming.App.Port, incoming.App.DataDir)

			if incoming.App.Port == 0 {
				http.Error(w, "invalid config: app.port missing", 400)
				return
			}
			if incoming.Email.Enabled {
				if incoming.Email.IMAPHost == "" || incoming.Email.Username == "" {
					http.Error(w, "invalid config: email enabled but missing host/username", 400)
					return
				}
			}

			if err := config.SaveAtomic(userCfgPath, incoming); err != nil {
				http.Error(w, err.Error(), 400)
				return
			}

			saved, err := loadCfg()
			if err != nil {
				http.Error(w, "saved but reload failed: "+err.Error(), 500)
				return
			}
			cfgVal.Store(saved)
			writeJSON(w, saved)
			return

		default:
			http.Error(w, "GET or PUT only", 405)
			return
		}
	})
	mux.HandleFunc("/config/path", func(w http.ResponseWriter, r *http.Request) {
		abs, _ := filepath.Abs(userCfgPath)
		writeJSON(w, map[string]any{"path": abs})
	})
	mux.HandleFunc("/scrape/status", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "GET only", 405)
			return
		}
		st := scrapeStatus.Load().(ScrapeStatus)
		writeJSON(w, st)
	})

	mux.HandleFunc("/scrape/run", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", 405)
			return
		}

		// prevent concurrent runs
		st := scrapeStatus.Load().(ScrapeStatus)
		if st.Running {
			writeJSON(w, map[string]any{"ok": false, "msg": "already running"})
			return
		}

		// run async so request returns quickly
		scrapeStatus.Store(ScrapeStatus{
			LastRunAt: time.Now().Format(time.RFC3339),
			Running:   true,
			LastError: "",
			LastAdded: 0,
			LastOkAt:  st.LastOkAt,
		})

		go func() {
			added, err := scrape.RunEmailScrapeOnce(db, cfgVal.Load().(config.Config), func() {
				hub.publish(`{"type":"job_created"}`)
			})
			now := time.Now().Format(time.RFC3339)

			next := scrapeStatus.Load().(ScrapeStatus)
			next.Running = false
			next.LastRunAt = now
			next.LastAdded = added
			if err != nil {
				next.LastError = err.Error()
			} else {
				next.LastError = ""
				next.LastOkAt = now
			}
			scrapeStatus.Store(next)
		}()

		writeJSON(w, map[string]any{"ok": true})
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
			w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(204)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func migrate(db *sql.DB) error {
	if _, err := db.Exec(`
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
);`); err != nil {
		return err
	}

	{
		var has bool
		rows, err := db.Query(`PRAGMA table_info(jobs);`)
		if err != nil {
			return err
		}
		defer rows.Close()

		for rows.Next() {
			var cid int
			var name, typ string
			var notnull, pk int
			var dflt sql.NullString
			if err := rows.Scan(&cid, &name, &typ, &notnull, &dflt, &pk); err != nil {
				return err
			}
			if name == "source_id" {
				has = true
				break
			}
		}
		if err := rows.Err(); err != nil {
			return err
		}

		if !has {
			if _, err := db.Exec(`ALTER TABLE jobs ADD COLUMN source_id TEXT NOT NULL DEFAULT '';`); err != nil {
				return err
			}
		}
	}

	if _, err := db.Exec(`
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_source_id
ON jobs(source_id)
WHERE source_id != '';
`); err != nil {
		return err
	}

	return nil
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

func deleteJob(ctx context.Context, db *sql.DB, id int64) error {
	_, err := db.ExecContext(ctx, `DELETE FROM jobs WHERE id = ?;`, id)
	return err
}

func startEmailPoller(db *sql.DB, cfgVal *atomic.Value, scrapeStatus *atomic.Value, hub *eventHub) {
	go func() {
		// run forever; interval is read from cfg on each loop so config updates apply live
		var lastTick time.Time

		for {
			cfg := cfgVal.Load().(config.Config)
			sec := cfg.Polling.EmailSeconds
			if sec <= 0 {
				sec = 60
			}

			// sleep until next tick (dynamic interval)
			if !lastTick.IsZero() {
				time.Sleep(time.Duration(sec) * time.Second)
			}
			lastTick = time.Now()

			if !cfg.Email.Enabled {
				continue
			}

			// Prevent concurrent runs (shares the same status guard)
			st := scrapeStatus.Load().(ScrapeStatus)
			if st.Running {
				continue
			}

			scrapeStatus.Store(ScrapeStatus{
				LastRunAt: time.Now().Format(time.RFC3339),
				Running:   true,
				LastError: "",
				LastAdded: 0,
				LastOkAt:  st.LastOkAt,
			})

			added, err := scrape.RunEmailScrapeOnce(db, cfg, func() {
				hub.publish(`{"type":"job_created"}`)
			})
			now := time.Now().Format(time.RFC3339)

			next := scrapeStatus.Load().(ScrapeStatus)
			next.Running = false
			next.LastRunAt = now
			next.LastAdded = added
			if err != nil {
				next.LastError = err.Error()
			} else {
				next.LastError = ""
				next.LastOkAt = now
			}
			scrapeStatus.Store(next)
		}
	}()
}
