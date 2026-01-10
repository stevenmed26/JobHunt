package types

import (
	"context"
	"jobhunt-engine/internal/domain"
)

type ScrapeResult struct {
	Source   string
	Leads    []domain.JobLead
	Finalize func(context.Context) error
}

type Fetcher interface {
	Name() string
	Fetch(ctx context.Context) (ScrapeResult, error)
}
