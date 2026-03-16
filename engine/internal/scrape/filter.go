package scrape

import (
	"strings"

	"jobhunt-engine/internal/config"
	"jobhunt-engine/internal/domain"
)

func ShouldKeepJob(cfg config.Config, j domain.JobLead) (keep bool, reason string) {
	// 1) Location filter (biggest filter)
	if !passesLocation(cfg, j) {
		return false, "location"
	}

	// 2) Must match at least one title/keyword rule
	if !matchesAnyRule(cfg, j) {
		return false, "no_keyword_match"
	}

	return true, ""
}

func passesLocation(cfg config.Config, j domain.JobLead) bool {
	text := strings.ToLower(strings.TrimSpace(j.LocationRaw))
	title := strings.ToLower(strings.TrimSpace(j.Title))
	desc := strings.ToLower(strings.TrimSpace(j.Description))

	// treat any mention of "remote" as remote-ish
	isRemote := strings.Contains(text, "remote") || strings.Contains(title, "remote") || strings.Contains(desc, "remote")

	// Blocklist wins
	for _, b := range cfg.Filters.LocationsBlock {
		b = strings.ToLower(strings.TrimSpace(b))
		if b == "" {
			continue
		}
		if strings.Contains(text, b) || strings.Contains(title, b) || strings.Contains(desc, b) {
			return false
		}
	}

	// Remote handling
	if isRemote && cfg.Filters.RemoteOK {
		// still allowed (unless blocked above)
		return true
	}
	if isRemote && !cfg.Filters.RemoteOK {
		return false
	}

	// Allowlist: if empty, allow everything (besides blocklist)
	allow := cfg.Filters.LocationsAllow
	if len(allow) == 0 {
		return true
	}

	// require at least one allow hit in location/title/desc
	for _, a := range allow {
		a = strings.ToLower(strings.TrimSpace(a))
		if a == "" {
			continue
		}
		if strings.Contains(text, a) || strings.Contains(title, a) || strings.Contains(desc, a) {
			return true
		}
	}
	return false
}

func matchesAnyRule(cfg config.Config, j domain.JobLead) bool {
	text := strings.ToLower(j.Title + " " + j.Description)

	hit := func(rules []config.Rule) bool {
		for _, r := range rules {
			for _, needle := range r.Any {
				n := strings.ToLower(strings.TrimSpace(needle))
				if n == "" {
					continue
				}
				if strings.Contains(text, n) {
					return true
				}
			}
		}
		return false
	}

	return hit(cfg.Scoring.TitleRules) || hit(cfg.Scoring.KeywordRules)
}
