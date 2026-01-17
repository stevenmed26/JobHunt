package httpapi

import (
	"encoding/json"
	"net/http"
)

type APIError struct {
	Error struct {
		Code      string `json:"code"`
		Message   string `json:"message"`
		RequestID string `json:"request_id,omitempty"`
	} `json:"error"`
}

func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func WriteError(w http.ResponseWriter, r *http.Request, status int, code, message string) {
	var e APIError
	e.Error.Code = code
	e.Error.Message = message
	e.Error.RequestID = RequestIDFrom(r.Context())
	WriteJSON(w, status, e)
}
