package util

import (
	"context"
	"net/url"
	"sync"

	"golang.org/x/time/rate"
)

// HostLimiter rate-limits per hostname (api.lever.co, boards.greenhouse.io, etc).
type HostLimiter struct {
	mu sync.Mutex
	m  map[string]*rate.Limiter
	r  rate.Limit
	b  int
}

func NewHostLimiter(reqPerSec float64, burst int) *HostLimiter {
	return &HostLimiter{
		m: make(map[string]*rate.Limiter),
		r: rate.Limit(reqPerSec),
		b: burst,
	}
}

func (hl *HostLimiter) limiterFor(host string) *rate.Limiter {
	hl.mu.Lock()
	defer hl.mu.Unlock()

	if lim, ok := hl.m[host]; ok {
		return lim
	}
	lim := rate.NewLimiter(hl.r, hl.b)
	hl.m[host] = lim
	return lim
}

func (hl *HostLimiter) WaitURL(ctx context.Context, raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return hl.limiterFor("_").Wait(ctx)
	}
	return hl.limiterFor(u.Host).Wait(ctx)
}
