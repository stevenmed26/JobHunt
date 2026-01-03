package scheduler

import (
	"context"
	"log"
	"time"
)

type Task func(ctx context.Context) error

func Every(ctx context.Context, interval time.Duration, name string, task Task) {
	t := time.NewTicker(interval)
	defer t.Stop()

	// run immediately
	go func() {
		if err := task(ctx); err != nil {
			log.Printf("[%s] error: %v", name, err)
		}
	}()

	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := task(ctx); err != nil {
				log.Printf("[%s] error: %v", name, err)
			}
		}
	}
}
