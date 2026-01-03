package rank

import "jobhunt-engine/internal/domain"

type Scorer interface {
	Score(job domain.JobLead) (score int, tags []string)
}
