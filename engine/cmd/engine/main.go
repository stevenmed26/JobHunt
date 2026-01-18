package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"sync/atomic"

	"jobhunt-engine/internal/config"
	"jobhunt-engine/internal/events"
	"jobhunt-engine/internal/httpapi"
	"jobhunt-engine/internal/poll"
	"jobhunt-engine/internal/scrape/types"
	"jobhunt-engine/internal/store"

	_ "modernc.org/sqlite"

	"github.com/gofrs/flock"
)

func main() {
	if err := run(); err != nil {
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

	// TryLock is non-blocking
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
	userCompaniesPath, err := config.EnsureUserCompaniesConfig(dataDir)
	if err != nil {
		return fmt.Errorf("config bootstrap failed: %v", err)
	}
	// Load config and keep it reloadable
	var cfgVal atomic.Value // stores config.Config

	loadCfg := func() (config.Config, error) {
		cfg, err := config.Load(userCfgPath)
		if err != nil {
			return cfg, nil
		}

		if err := config.OverlayCompanies(&cfg, userCompaniesPath); err != nil {
			return cfg, fmt.Errorf("load companies (%s): %w", userCompaniesPath, err)
		}

		cfg, vr := config.NormalizeAndValidate(cfg)
		if !vr.OK() {
			log.Printf("[config] INVALID: %v", vr.Errors)
		}
		for _, w := range vr.Warnings {
			log.Printf("[config] WARN: %s", w)
		}

		log.Printf("[config] GH=%d Lever=%d companiesPath=%s",
			len(cfg.Sources.Greenhouse.Companies),
			len(cfg.Sources.Lever.Companies),
			userCompaniesPath,
		)
		return cfg, nil
	}
	cfg, err := loadCfg()
	if err != nil {
		return fmt.Errorf("config load failed (%s): %v", userCfgPath, err)
	}

	cfgVal.Store(cfg)

	// Load scrape status
	var scrapeStatus atomic.Value // stores scrape.ScrapeStatus
	scrapeStatus.Store(types.ScrapeStatus{})

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
	poll.StartPoller(db, &cfgVal, &scrapeStatus, hub)

	// Build API mux from internal/httpapi package

	mux := httpapi.NewMux(httpapi.Deps{
		DB:           db,
		Hub:          hub,
		CfgVal:       &cfgVal,
		ScrapeStatus: &scrapeStatus,

		UserCfgPath: userCfgPath,
		LoadCfg:     loadCfg,

		DeleteJob: httpapi.DeleteJob,

		RunPollOnce: poll.PollOnce,
	})

	// Bind to a predictable local port
	addr := "127.0.0.1:38471"
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("%s", err)
	}
	log.Printf("level=info msg=\"engine listening\" addr=%s db=%s", addr, dbPath)

	handler := httpapi.Chain(
		httpapi.Cors(mux),
		httpapi.Recover,
		httpapi.RequestID,
		httpapi.AccessLog,
	)

	srv := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
	}

	shutdownToken, err := httpapi.RandomToken(32)
	if err != nil {
		return err
	}
	log.Printf("shutdown_token=%s", shutdownToken)

	// /shutdown must be registered here because it needs srv + token
	mux.HandleFunc("/shutdown", httpapi.ShutdownHandler(&shutdownToken, srv))

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)

	go func() {
		<-stop
		log.Printf("level=info msg=\"signal received; shutting down\"")
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	}()

	err = srv.Serve(ln)
	if err == http.ErrServerClosed {
		log.Printf("level=info msg=\"server closed\"")
		return nil
	}
	if err != nil {
		return fmt.Errorf("server error: %w", err)
	}
	return nil
}
