package http

import (
	"net/http"

	"jobhunt-engine/internal/http/handlers"
)

func Routes(h handlers.Handlers) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", h.JobsList)
	return mux
}
