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
		http.Error(w, "streaming unsupported", 500)
		return
	}

	ch := h.Hub.Subscribe()
	defer h.Hub.Unsubscribe(ch)

	fmt.Fprintf(w, "event: ping\ndata: %s\n\n", `{"type":"ping"}`)
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
