package httpapi

import (
	"fmt"
	"net/http"

	"jobhunt-engine/internal/events"
)

type EventsHandler struct {
	Hub *events.Hub
}

func (h EventsHandler) ServeSSE(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	flusher, ok := w.(http.Flusher)
	if !ok {
		WriteError(w, r, http.StatusInternalServerError, "stream_unsupported", "Streaming unsupported")
		return
	}

	ch := h.Hub.Subscribe()
	defer h.Hub.Unsubscribe(ch)

	// Ping as a proper event envelope
	reqID := RequestIDFrom(r.Context())
	ping := events.MakeEvent(reqID, "ping", 1, nil)
	fmt.Fprintf(w, "event: message\ndata: %s\n\n", ping)
	flusher.Flush()

	for {
		select {
		case <-r.Context().Done():
			return
		case msg := <-ch:
			fmt.Fprintf(w, "event: message\ndata: %s\n\n", msg)
			flusher.Flush()
		}
	}
}
