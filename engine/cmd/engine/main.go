package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"sync/atomic"

	"jobhunt-engine/internal/config"
	"jobhunt-engine/internal/events"
	"jobhunt-engine/internal/httpapi"
	apirouter "jobhunt-engine/internal/httpapi" // new router + handlers
	email_scrape "jobhunt-engine/internal/scrape/email"
	"jobhunt-engine/internal/store"

	_ "modernc.org/sqlite"

	"github.com/gofrs/flock"
)

func main() {
	if err := run(); err != nil {
		log.Printf("fatal: %v", err)
		os.Exit(1)
	}
}

func run() error {
	dataDir := os.Getenv("JOBHUNT_DATA_DIR")
	if dataDir == "" {
		dataDir = "."
	}
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return fmt.Errorf("%s", err)
	}

	lockPath := filepath.Join(dataDir, "engine.lock")
	lk := flock.New(lockPath)

	// TryLock is non-blocking (preferred for “only one instance”)
	deadline := time.Now().Add(1 * time.Second)
	for {
		locked, err := lk.TryLock()
		if err != nil {
			return err
		}
		if locked {
			break
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("engine is already running: %s", lockPath)
		}
		time.Sleep(50 * time.Millisecond)
	}
	defer func() { _ = lk.Unlock() }()

	userCfgPath, err := config.EnsureUserConfig(dataDir)
	if err != nil {
		return fmt.Errorf("config bootstrap failed: %v", err)
	}

	// Load config and keep it reloadable
	var cfgVal atomic.Value // stores config.Config
	loadCfg := func() (config.Config, error) {
		return config.Load(userCfgPath)
	}
	cfg, err := loadCfg()
	if err != nil {
		return fmt.Errorf("config load failed (%s): %v", userCfgPath, err)
	}
	cfgVal.Store(cfg)

	// Load scrape status
	var scrapeStatus atomic.Value // stores apirouter.ScrapeStatus
	scrapeStatus.Store(apirouter.ScrapeStatus{})

	dbPath := filepath.Join(dataDir, "jobhunt.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return fmt.Errorf("%s", err)
	}
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
	defer db.Close()

	if err := store.Migrate(db); err != nil {
		return fmt.Errorf("%s", err)
	}
	if _, err := store.CleanupOldJobs(db); err != nil {
		log.Printf("[retention] cleanup failed: %v", err)
	}

	// SSE hub lives outside main now (importable by handlers)
	hub := events.NewHub()

	// Background poller stays in main, but uses shared types + hub
	startEmailPoller(db, &cfgVal, &scrapeStatus, hub)

	// Build API mux from internal/httpapi package
	mux := apirouter.NewMux(apirouter.Deps{
		DB:           db,
		Hub:          hub,
		CfgVal:       &cfgVal,
		ScrapeStatus: &scrapeStatus,

		UserCfgPath: userCfgPath,
		LoadCfg:     loadCfg,

		DeleteJob: deleteJob,

		RunEmailScrape: email_scrape.RunEmailScrapeOnce,
	})

	// Bind to a predictable local port for now (simpler).
	addr := "127.0.0.1:38471"
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("%s", err)
	}
	log.Printf("engine listening on http://%s (db=%s)", addr, dbPath)

	srv := &http.Server{
		Handler:           httpapi.Cors(mux),
		ReadHeaderTimeout: 5 * time.Second,
	}

	shutdownToken, err := randomToken(32)
	if err != nil {
		return err
	}
	log.Printf("shutdown_token=%s", shutdownToken)

	// /shutdown must be registered here because it needs srv + token
	mux.HandleFunc("/shutdown", shutdownHandler(&shutdownToken, srv))

	return fmt.Errorf("%s", srv.Serve(ln))
}

func deleteJob(ctx context.Context, db *sql.DB, id int64) error {
	_, err := db.ExecContext(ctx, `DELETE FROM jobs WHERE id = ?;`, id)
	return err
}

func startEmailPoller(db *sql.DB, cfgVal *atomic.Value, scrapeStatus *atomic.Value, hub *events.Hub) {
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
			st := scrapeStatus.Load().(apirouter.ScrapeStatus)
			if st.Running {
				continue
			}

			scrapeStatus.Store(apirouter.ScrapeStatus{
				LastRunAt: time.Now().Format(time.RFC3339),
				Running:   true,
				LastError: "",
				LastAdded: 0,
				LastOkAt:  st.LastOkAt,
			})

			added, err := email_scrape.RunEmailScrapeOnce(db, cfg, func() {
				hub.Publish(`{"type":"job_created"}`)
			})
			now := time.Now().Format(time.RFC3339)

			next := scrapeStatus.Load().(apirouter.ScrapeStatus)
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
