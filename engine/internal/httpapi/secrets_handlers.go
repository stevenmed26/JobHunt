package httpapi

import (
	"encoding/json"
	"net/http"
	"sync/atomic"

	"jobhunt-engine/internal/config"
	"jobhunt-engine/internal/secrets"
)

type SecretsHandler struct {
	CfgVal *atomic.Value // stores config.Config
}

type setIMAPPasswordReq struct {
	Password string `json:"password"`
}

func (h SecretsHandler) SetIMAPPassword(w http.ResponseWriter, r *http.Request) {
	var req setIMAPPasswordReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	cfg := h.CfgVal.Load().(config.Config)
	if err := secrets.SetIMAPPassword(secrets.IMAPKeyringAccount(cfg), req.Password); err != nil {
		http.Error(w, "failed to store password: "+err.Error(), http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// SetGroqAPIKey stores the Groq key in the OS keyring.
// POST /api/secrets/groq  { "api_key": "gsk_..." }
func (h SecretsHandler) SetGroqAPIKey(w http.ResponseWriter, r *http.Request) {
	var req struct {
		APIKey string `json:"api_key"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if err := secrets.SetGroqAPIKey(req.APIKey); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

// GetGroqKeyStatus returns whether a key is stored without exposing the value.
// GET /api/secrets/groq/status  →  { "has_key": true }
func (h SecretsHandler) GetGroqKeyStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]any{"has_key": secrets.HasGroqAPIKey()})
}
