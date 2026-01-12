package httpapi

import (
	"context"
	"crypto/subtle"
	"net"
	"net/http"
	"time"
)

// NewMux returns the raw mux so main() can still attach /shutdown (needs srv+token).
func NewMux(d Deps) *http.ServeMux {
	mux := http.NewServeMux()

	// Jobs
	jh := JobsHandler{DB: d.DB, Hub: d.Hub, DeleteJob: d.DeleteJob}
	mux.HandleFunc("/jobs", methodMux(map[string]http.HandlerFunc{
		http.MethodGet: jh.List,
	}))
	mux.HandleFunc("/jobs/", methodMux(map[string]http.HandlerFunc{
		http.MethodDelete: jh.DeleteByPath, // expects /jobs/{id}
	}))
	mux.HandleFunc("/seed", methodMux(map[string]http.HandlerFunc{
		http.MethodPost: jh.Seed,
	}))

	// Config
	ch := ConfigHandler{
		CfgVal:      d.CfgVal,
		UserCfgPath: d.UserCfgPath,
		LoadCfg:     d.LoadCfg,
	}
	mux.HandleFunc("/config", methodMux(map[string]http.HandlerFunc{
		http.MethodGet: ch.Get,
		http.MethodPut: ch.Put,
	}))
	mux.HandleFunc("/config/path", methodMux(map[string]http.HandlerFunc{
		http.MethodGet: ch.Path,
	}))

	// Secrets (use cfgVal, NOT a snapshot cfg)
	sh := SecretsHandler{CfgVal: d.CfgVal}
	mux.HandleFunc("/api/secrets/imap", methodMux(map[string]http.HandlerFunc{
		http.MethodPost: sh.SetIMAPPassword,
	}))

	// Scrape
	sch := ScrapeHandler{
		DB:             d.DB,
		CfgVal:         d.CfgVal,
		ScrapeStatus:   d.ScrapeStatus,
		Hub:            d.Hub,
		RunEmailScrape: d.RunEmailScrape,
	}
	mux.HandleFunc("/scrape/status", methodMux(map[string]http.HandlerFunc{
		http.MethodGet: sch.Status,
	}))
	mux.HandleFunc("/scrape/run", methodMux(map[string]http.HandlerFunc{
		http.MethodPost: sch.Run,
	}))

	// SSE events
	eh := EventsHandler{Hub: d.Hub}
	mux.HandleFunc("/events", methodMux(map[string]http.HandlerFunc{
		http.MethodGet: eh.ServeSSE,
	}))

	// Logos
	lh := LogosHandler{DB: d.DB}
	mux.HandleFunc("/logo/", methodMux(map[string]http.HandlerFunc{
		http.MethodGet: lh.GetByPath,
	}))

	return mux
}

func ShutdownHandler(token *string, srv *http.Server) http.HandlerFunc {
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
