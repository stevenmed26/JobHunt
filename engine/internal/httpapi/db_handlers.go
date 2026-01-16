package httpapi

import (
	"database/sql"
	"net"
	"net/http"
)

type DBHandler struct {
	DB *sql.DB
}

func (h DBHandler) Checkpoint(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if host != "127.0.0.1" && host != "::1" && host != "localhost" {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	if _, err := h.DB.Exec(`PRAGMA wal_checkpoint(FULL);`); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
