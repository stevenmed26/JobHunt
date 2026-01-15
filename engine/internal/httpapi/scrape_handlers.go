package httpapi

import (
	"database/sql"
	"net/http"
	"sync/atomic"
	"time"

	"jobhunt-engine/internal/config"
	"jobhunt-engine/internal/events"
)

type ScrapeHandler struct {
	DB             *sql.DB
	CfgVal         *atomic.Value // config.Config
	ScrapeStatus   *atomic.Value // httpapi.ScrapeStatus
	Hub            *events.Hub
	RunEmailScrape func(db *sql.DB, cfg config.Config, onNewJob func()) (added int, err error)
}

func (h ScrapeHandler) Status(w http.ResponseWriter, r *http.Request) {
	st := h.ScrapeStatus.Load().(ScrapeStatus)
	writeJSON(w, st)
}

func (h ScrapeHandler) Run(w http.ResponseWriter, r *http.Request) {
	st := h.ScrapeStatus.Load().(ScrapeStatus)
	if st.Running {
		writeJSON(w, map[string]any{"ok": false, "msg": "already running"})
		return
	}

	h.ScrapeStatus.Store(ScrapeStatus{
		LastRunAt: time.Now().Format(time.RFC3339),
		Running:   true,
		LastError: "",
		LastAdded: 0,
		LastOkAt:  st.LastOkAt,
	})

	go func() {
		cfg := h.CfgVal.Load().(config.Config)
		added, err := h.RunEmailScrape(h.DB, cfg, func() {
			h.Hub.Publish(`{"type":"job_created"}`)
		})

		now := time.Now().Format(time.RFC3339)
		next := h.ScrapeStatus.Load().(ScrapeStatus)
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
