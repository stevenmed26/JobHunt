package httpapi

import (
	"database/sql"
	"fmt"
	"net/http"
	"sync/atomic"
	"time"

	"jobhunt-engine/internal/config"
	"jobhunt-engine/internal/events"
	"jobhunt-engine/internal/scrape/types"
)

type ScrapeHandler struct {
	DB           *sql.DB
	CfgVal       *atomic.Value // config.Config
	ScrapeStatus *atomic.Value // httpapi.ScrapeStatus
	Hub          *events.Hub
	PollOnce     func(db *sql.DB, cfg config.Config, onNewJob func()) (added int, err error)
}

func (h ScrapeHandler) Status(w http.ResponseWriter, r *http.Request) {
	st := h.ScrapeStatus.Load().(types.ScrapeStatus)
	writeJSON(w, st)
}

func (h ScrapeHandler) Run(w http.ResponseWriter, r *http.Request) {
	st := h.ScrapeStatus.Load().(types.ScrapeStatus)
	if st.Running {
		writeJSON(w, map[string]any{"ok": false, "msg": "already running"})
		return
	}

	h.ScrapeStatus.Store(types.ScrapeStatus{
		LastRunAt: time.Now().Format(time.RFC3339),
		Running:   true,
		LastError: "",
		LastAdded: 0,
		LastOkAt:  st.LastOkAt,
	})

	go func() {
		defer func() {
			if v := recover(); v != nil {
				now := time.Now().Format(time.RFC3339)
				nextAny := h.ScrapeStatus.Load()
				next, _ := nextAny.(types.ScrapeStatus)
				next.Running = false
				next.LastRunAt = now
				next.LastError = fmt.Sprintf("panic: %v", v)
				h.ScrapeStatus.Store(next)
			}
		}()

		cfgAny := h.CfgVal.Load()
		cfg, ok := cfgAny.(config.Config)
		if !ok {
			now := time.Now().Format(time.RFC3339)
			nextAny := h.ScrapeStatus.Load()
			next, _ := nextAny.(types.ScrapeStatus)
			next.Running = false
			next.LastRunAt = now
			next.LastError = "config not loaded"
			h.ScrapeStatus.Store(next)
			return
		}

		added, err := h.PollOnce(h.DB, cfg, func() {
			reqID := RequestIDFrom(r.Context())
			h.Hub.Publish(events.MakeEvent(reqID, "job_created", 1, nil))
		})

		now := time.Now().Format(time.RFC3339)
		nextAny := h.ScrapeStatus.Load()
		next, _ := nextAny.(types.ScrapeStatus)
		next.Running = false
		next.LastRunAt = now
		next.LastAdded = added
		if err != nil {
			next.LastError = err.Error()
		} else {
			next.LastError = ""
			next.LastOkAt = now
		}
		h.ScrapeStatus.Store(next)
	}()

	writeJSON(w, map[string]any{"ok": true})
}
