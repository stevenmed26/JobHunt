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
