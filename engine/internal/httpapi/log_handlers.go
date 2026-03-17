package httpapi

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"
)

// LogHandler receives structured log entries from the browser extension and
// prints them to the engine's stdout so they appear in the cmd console
// alongside [engine stdout] lines from the Tauri shell.

type LogHandler struct{}

type logEntry struct {
	Level   string `json:"level"`  // "info" | "warn" | "error"
	Source  string `json:"source"` // e.g. "extension", "content-script"
	Message string `json:"message"`
}

// POST /api/log
func (h LogHandler) Log(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 64<<10))
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	var entry logEntry
	if err := json.Unmarshal(body, &entry); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	ts := time.Now().Format("15:04:05")

	switch entry.Level {
	case "warn":
		log.Printf("[%s] [%s] WARN  %s", ts, entry.Source, entry.Message)
	case "error":
		log.Printf("[%s] [%s] ERROR %s", ts, entry.Source, entry.Message)
	default:
		fmt.Printf("[%s] [%s] %s\n", ts, entry.Source, entry.Message)
	}

	w.WriteHeader(http.StatusNoContent)
}
