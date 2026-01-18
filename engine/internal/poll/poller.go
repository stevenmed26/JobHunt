package poll

import (
	"database/sql"
	"log"
	"sync/atomic"
	"time"

	"jobhunt-engine/internal/config"
	"jobhunt-engine/internal/events"
	"jobhunt-engine/internal/scrape/types"
)

func StartPoller(db *sql.DB, cfgVal *atomic.Value, scrapeStatus *atomic.Value, hub *events.Hub) {
	go func() {
		t := time.NewTicker(3 * time.Hour) // Poll every 3 hours
		defer t.Stop()

		for range t.C {
			cfgAny := cfgVal.Load()
			if cfgAny == nil {
				continue
			}
			cfg := cfgAny.(config.Config)

			// If nothing enabled, skip quietly
			if !cfg.Email.Enabled && !cfg.Sources.Greenhouse.Enabled && !cfg.Sources.Lever.Enabled {
				continue
			}

			// Mark running
			stAny := scrapeStatus.Load()
			st := types.ScrapeStatus{}
			if stAny != nil {
				st = stAny.(types.ScrapeStatus)
			}
			st.Running = true
			st.LastRunAt = time.Now().Format(time.RFC3339)
			scrapeStatus.Store(st)

			added, err := PollOnce(db, cfg, func() {
				// SSE notify

			})

			// Update status
			stAny = scrapeStatus.Load()
			st = types.ScrapeStatus{}
			if stAny != nil {
				st = stAny.(types.ScrapeStatus)
			}
			st.Running = false
			st.LastAdded = added

			if err != nil {
				st.LastError = err.Error()
				log.Printf("[poll] error: %v", err)
			} else {
				st.LastError = ""
				st.LastOkAt = time.Now().Format(time.RFC3339)
				log.Printf("[poll] ok added=%d", added)
			}
			scrapeStatus.Store(st)
		}
	}()
}
