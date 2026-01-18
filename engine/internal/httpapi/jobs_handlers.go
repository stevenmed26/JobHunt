package httpapi

import (
	"context"
	"database/sql"
	"net/http"
	"strconv"
	"strings"

	"jobhunt-engine/internal/events"
	"jobhunt-engine/internal/store"
)

type JobsHandler struct {
	DB        *sql.DB
	Hub       *events.Hub
	DeleteJob func(ctx context.Context, db *sql.DB, id int64) error
}

func (h JobsHandler) List(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	sort := q.Get("sort")
	window := q.Get("window")

	jobs, err := store.ListJobs(r.Context(), h.DB, store.ListJobsOpts{
		Sort: sort, Window: window, Limit: 50000,
	})
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeJSON(w, jobs)
}

func (h JobsHandler) DeleteByPath(w http.ResponseWriter, r *http.Request) {
	idStr := strings.TrimPrefix(r.URL.Path, "/jobs/")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || id <= 0 {
		http.Error(w, "invalid id", 400)
		return
	}

	if err := h.DeleteJob(r.Context(), h.DB, id); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}

	reqID := RequestIDFrom(r.Context())
	h.Hub.Publish(events.MakeEvent(reqID, "job_deleted", 1, map[string]any{"id": id}))
	// h.Hub.Publish(`{"type":"job_deleted","id":` + fmt.Sprint(id) + `}`)
	writeJSON(w, map[string]any{"ok": true, "id": id})
}

func (h JobsHandler) Seed(w http.ResponseWriter, r *http.Request) {
	job, err := store.SeedJob(r.Context(), h.DB)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	reqID := RequestIDFrom(r.Context())
	h.Hub.Publish(events.MakeEvent(reqID, "job_created", 1, map[string]any{"id": job.ID}))
	// h.Hub.Publish(`{"type":"job_created","id":` + fmt.Sprint(job.ID) + `}`)
	writeJSON(w, job)
}

func DeleteJob(ctx context.Context, db *sql.DB, id int64) error {
	_, err := db.ExecContext(ctx, `DELETE FROM jobs WHERE id = ?;`, id)
	return err
}
