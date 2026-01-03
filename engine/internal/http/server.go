package http

import (
	"log"
	"net/http"
)

func Start(addr string, handler http.Handler) error {
	log.Printf("api listening on %s", addr)
	return http.ListenAndServe(addr, handler)
}
