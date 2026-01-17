package httpapi

import (
	"context"
	"database/sql"
	"sync/atomic"

	"jobhunt-engine/internal/config"
	"jobhunt-engine/internal/events"
)

type Deps struct {
	DB *sql.DB

	Hub *events.Hub

	// Atomic stores
	CfgVal       *atomic.Value // stores config.Config
	ScrapeStatus *atomic.Value // stores httpapi.ScrapeStatus

	// Config persistence
	UserCfgPath string
	LoadCfg     func() (config.Config, error)

	DeleteJob func(ctx context.Context, db *sql.DB, id int64) error

	// Scrape entrypoint (inject for testability)
	RunPollOnce func(db *sql.DB, cfg config.Config, onNewJob func()) (added int, err error)
}
