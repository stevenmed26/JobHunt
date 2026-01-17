package types

import (
	"context"
	"jobhunt-engine/internal/domain"
	"time"
)

type ScrapeResult struct {
	Source   string
	Leads    []domain.JobLead
	Finalize func(context.Context) error
}

type ScrapeStatus struct {
	LastRunAt string `json:"last_run_at"`
	LastOkAt  string `json:"last_ok_at"`
	LastError string `json:"last_error"`
	LastAdded int    `json:"last_added"`
	Running   bool   `json:"running"`
}

type Fetcher interface {
	Name() string
	Fetch(ctx context.Context) (ScrapeResult, error)
}

type JobRow struct {
	Company        string
	Title          string
	Location       string
	WorkMode       string
	Description    string
	URL            string
	Score          int
	Tags           []string
	ReceivedAt     time.Time
	SourceID       string
	SeenFromSource string
	CompanyLogoURL string
}
