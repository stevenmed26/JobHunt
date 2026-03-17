package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
)

// ProfileHandler persists the applicant profile to a JSON file in the data dir.
// The Tauri app stores it in localStorage; the extension needs it from the engine.
// Both read/write the same file so they stay in sync.

type ProfileHandler struct {
	DataDir string
}

func (h ProfileHandler) profilePath() string {
	dir := h.DataDir
	if dir == "" {
		dir = "."
	}
	return filepath.Join(dir, "applicant_profile.json")
}

// GET /api/profile — returns the stored profile, or an empty object if none saved yet
func (h ProfileHandler) Get(w http.ResponseWriter, r *http.Request) {
	data, err := os.ReadFile(h.profilePath())
	if err != nil {
		// No profile saved yet — return empty object so extension can detect this
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("{}"))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(data)
}

// POST /api/profile — saves the profile from the Tauri app so the extension can read it
func (h ProfileHandler) Save(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 512<<10))
	if err != nil {
		http.Error(w, "failed to read body", http.StatusBadRequest)
		return
	}

	// Validate it's at least valid JSON
	var check map[string]any
	if err := json.Unmarshal(body, &check); err != nil {
		http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
		return
	}

	if err := os.WriteFile(h.profilePath(), body, 0o600); err != nil {
		http.Error(w, "failed to save profile: "+err.Error(), http.StatusInternalServerError)
		return
	}

	writeJSON(w, map[string]any{"ok": true})
}
