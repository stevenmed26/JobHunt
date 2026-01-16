package main

import "sync"

type eventHub struct {
	mu      sync.Mutex
	clients map[chan string]struct{}
}

func newHub() *eventHub {
	return &eventHub{clients: make(map[chan string]struct{})}
}

func (h *eventHub) subscribe() chan string {
	ch := make(chan string, 10)
	h.mu.Lock()
	h.clients[ch] = struct{}{}
	h.mu.Unlock()
	return ch
}

func (h *eventHub) unsubscribe(ch chan string) {
	h.mu.Lock()
	delete(h.clients, ch)
	h.mu.Unlock()
	close(ch)
}

func (h *eventHub) publish(evt string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.clients {
		select {
		case ch <- evt:
		default:
			// drop if slow
		}
	}
}
