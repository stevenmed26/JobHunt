package greenhouse

import (
	"context"

	"jobhunt-engine/internal/domain"
)

type Connector struct{}

func (c Connector) Type() string { return "greenhouse" }

// TODO: implement later. For now returns nothing.
func (c Connector) ListJobs(ctx context.Context, company domain.Company) ([]domain.JobLead, error) {
	return nil, nil
}
