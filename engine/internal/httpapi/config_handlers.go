package httpapi

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"sync/atomic"

	"jobhunt-engine/internal/config"
)

type ConfigHandler struct {
	CfgVal      *atomic.Value // stores config.Config
	UserCfgPath string
	LoadCfg     func() (config.Config, error)
}

func (h ConfigHandler) Get(w http.ResponseWriter, r *http.Request) {
	cur := h.CfgVal.Load().(config.Config)
	writeJSON(w, cur)
}

func (h ConfigHandler) Put(w http.ResponseWriter, r *http.Request) {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()

	var incoming config.Config
	if err := dec.Decode(&incoming); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), 400)
		return
	}
	if dec.More() {
		http.Error(w, "invalid JSON: trailing data", 400)
		return
	}

	if incoming.App.Port == 0 {
		http.Error(w, "invalid config: app.port missing", 400)
		return
	}
	if incoming.Email.Enabled {
		if incoming.Email.IMAPHost == "" || incoming.Email.Username == "" {
			http.Error(w, "invalid config: email enabled but missing host/username", 400)
			return
		}
	}

	if err := config.SaveAtomic(h.UserCfgPath, incoming); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	saved, err := h.LoadCfg()
	if err != nil {
		http.Error(w, "saved but reload failed: "+err.Error(), 500)
		return
	}
	h.CfgVal.Store(saved)
	writeJSON(w, saved)
}

func (h ConfigHandler) Path(w http.ResponseWriter, r *http.Request) {
	abs, _ := filepath.Abs(h.UserCfgPath)
	writeJSON(w, map[string]any{"path": abs})
}
