package ats

import (
	"context"

	"jobhunt-engine/internal/domain"
)

type Connector interface {
	Type() string
	ListJobs(ctx context.Context, company domain.Company) ([]domain.JobLead, error)
}
