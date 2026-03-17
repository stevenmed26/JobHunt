package httpapi

import (
	"context"
	"crypto/subtle"
	"net"
	"net/http"
	"strings"
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
	// /jobs/ catches both /jobs/{id} (DELETE) and /jobs/{id}/description (GET)
	mux.HandleFunc("/jobs/", func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if r.Method == http.MethodGet && strings.HasSuffix(path, "/description") {
			jh.Description(w, r)
			return
		}
		if r.Method == http.MethodDelete {
			jh.DeleteByPath(w, r)
			return
		}
		http.NotFound(w, r)
	})
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
	mux.HandleFunc("/config/validate", methodMux(map[string]http.HandlerFunc{
		http.MethodGet: ch.Validate,
	}))
	dbh := DBHandler{DB: d.DB}
	mux.HandleFunc("/db/checkpoint", methodMux(map[string]http.HandlerFunc{
		http.MethodPost: dbh.Checkpoint,
	}))

	// Secrets (use cfgVal, NOT a snapshot cfg)
	sh := SecretsHandler{CfgVal: d.CfgVal}
	mux.HandleFunc("/api/secrets/imap", methodMux(map[string]http.HandlerFunc{
		http.MethodPost: sh.SetIMAPPassword,
	}))
	mux.HandleFunc("/api/secrets/groq", methodMux(map[string]http.HandlerFunc{
		http.MethodPost: sh.SetGroqAPIKey,
	}))
	mux.HandleFunc("/api/secrets/groq/status", methodMux(map[string]http.HandlerFunc{
		http.MethodGet: sh.GetGroqKeyStatus,
	}))

	// Company search — probes Greenhouse/Lever APIs to find board slugs
	csh := CompanySearchHandler{}
	mux.HandleFunc("/api/companies/search", methodMux(map[string]http.HandlerFunc{
		http.MethodGet: csh.Search,
	}))

	// Company discovery — Lever sitemap, Greenhouse seed probing, URL extraction
	cdh := CompanyDiscoveryHandler{}
	mux.HandleFunc("/api/companies/discover", methodMux(map[string]http.HandlerFunc{
		http.MethodGet: cdh.Discover,
	}))
	mux.HandleFunc("/api/companies/extract", methodMux(map[string]http.HandlerFunc{
		http.MethodPost: cdh.Extract,
	}))

	// LLM proxy — keeps the API key server-side, avoids Tauri CSP block
	llmh := LLMHandler{}
	mux.HandleFunc("/api/llm", methodMux(map[string]http.HandlerFunc{
		http.MethodPost: llmh.ServeProxy,
	}))

	// Cover letter save
	clh := CoverLetterHandler{}
	mux.HandleFunc("/api/cover-letter/save", methodMux(map[string]http.HandlerFunc{
		http.MethodPost: clh.Save,
	}))

	// Applicant profile — shared between Tauri app and browser extension
	ph := ProfileHandler{DataDir: d.DataDir}
	mux.HandleFunc("/api/profile", methodMux(map[string]http.HandlerFunc{
		http.MethodGet:  ph.Get,
		http.MethodPost: ph.Save,
	}))

	// Apply — two-phase: scrape form fields, then fill with exact selectors
	ah := ApplyHandler{DB: d.DB, DataDir: d.DataDir}
	mux.HandleFunc("/api/apply/scrape", methodMux(map[string]http.HandlerFunc{
		http.MethodPost: ah.Scrape,
	}))
	mux.HandleFunc("/api/apply/fill", methodMux(map[string]http.HandlerFunc{
		http.MethodPost: ah.Fill,
	}))

	// Scrape
	sch := ScrapeHandler{
		DB:           d.DB,
		CfgVal:       d.CfgVal,
		ScrapeStatus: d.ScrapeStatus,
		Hub:          d.Hub,
		PollOnce:     d.RunPollOnce,
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
