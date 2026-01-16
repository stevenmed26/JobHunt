package httpapi

import (
	"database/sql"
	"net/http"
	"strings"
)

type LogosHandler struct {
	DB *sql.DB
}

func (h LogosHandler) GetByPath(w http.ResponseWriter, r *http.Request) {
	key := strings.TrimSpace(strings.TrimPrefix(r.URL.Path, "/logo/"))
	if key == "" {
		http.Error(w, "missing key", 400)
		return
	}

	var ct string
	var b []byte
	err := h.DB.QueryRowContext(r.Context(),
		`SELECT content_type, bytes FROM logos WHERE key = ? LIMIT 1;`, key,
	).Scan(&ct, &b)

	if err == sql.ErrNoRows {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}

	if ct == "" {
		ct = "image/*"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "public, max-age=604800")
	_, _ = w.Write(b)
}
