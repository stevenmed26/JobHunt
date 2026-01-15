package httpapi

import (
	"encoding/json"
	"net/http"
)

type HealthHandler struct{}

func (h HealthHandler) Health(w http.ResponseWriter, r *http.Request) {
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok": true,
	})
}
