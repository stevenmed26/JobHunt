package handlers

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"jobhunt-engine/internal/db"
)

type Handlers struct {
	DB *db.DB
}

type jobRow struct {
	Company   string
	Title     string
	Location  string
	WorkMode  string
	URL       string
	Score     int
	FirstSeen time.Time
	Status    string
}

func (h Handlers) JobsList(w http.ResponseWriter, r *http.Request) {
	ctx := context.Background()
	rows, err := h.DB.Pool.QueryContext(ctx, `
	  SELECT c.name, j.title, j.location_raw, j.work_mode, j.url, j.score, j.first_seen_at, j.status
	  FROM jobs j
	  JOIN companies c ON c.id = j.company_id
	  ORDER BY j.first_seen_at DESC
	  LIMIT 50`)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer rows.Close()

	fmt.Fprintln(w, "<html><body><h1>JobHunt</h1><p>(MVP list)</p><hr/>")
	for rows.Next() {
		var jr jobRow
		if err := rows.Scan(&jr.Company, &jr.Title, &jr.Location, &jr.WorkMode, &jr.URL, &jr.Score, &jr.FirstSeen, &jr.Status); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		fmt.Fprintf(w,
			`<div style="margin:12px 0;">
			  <div><b>%s</b> — %s</div>
			  <div>%s · %s · score=%d · first_seen=%s · status=%s</div>
			  <div><a href="%s" target="_blank">Apply</a></div>
			</div><hr/>`,
			escape(jr.Title), escape(jr.Company),
			escape(jr.Location), escape(jr.WorkMode), jr.Score,
			jr.FirstSeen.Format(time.RFC3339), escape(jr.Status),
			escapeAttr(jr.URL),
		)
	}
	fmt.Fprintln(w, "</body></html>")
}

func escape(s string) string {
	// small/cheap HTML escape for MVP
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;")
	return r.Replace(s)
}
func escapeAttr(s string) string { return escape(s) }

// tiny import to keep it simple
//import "strings"
