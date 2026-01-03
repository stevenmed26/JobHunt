// engine/internal/rank/yaml_scorer.go
package rank

import (
	"strings"

	"jobhunt-engine/internal/config"
	"jobhunt-engine/internal/domain"
)

type YAMLScorer struct {
	Cfg config.Config
}

func (s YAMLScorer) Score(job domain.JobLead) (int, []string) {
	text := strings.ToLower(job.Title + " " + job.Description)

	score := 0
	var tags []string

	applyRules := func(rules []config.Rule) {
		for _, r := range rules {
			for _, needle := range r.Any {
				n := strings.ToLower(needle)
				if strings.Contains(text, n) {
					score += r.Weight
					tags = append(tags, r.Tag)
					break
				}
			}
		}
	}

	applyRules(s.Cfg.Scoring.TitleRules)
	applyRules(s.Cfg.Scoring.KeywordRules)

	for _, p := range s.Cfg.Scoring.Penalties {
		for _, needle := range p.Any {
			n := strings.ToLower(needle)
			if strings.Contains(text, n) {
				score += p.Weight
				break
			}
		}
	}

	return score, uniq(tags)
}

func uniq(in []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(in))
	for _, t := range in {
		if !seen[t] {
			seen[t] = true
			out = append(out, t)
		}
	}
	return out
}
