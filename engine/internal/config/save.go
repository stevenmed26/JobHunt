package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

func Validate(cfg Config) error {
	var errs []string

	if cfg.App.Port <= 0 || cfg.App.Port > 65535 {
		errs = append(errs, "app.port must be 1..65535")
	}
	if cfg.Scoring.NotifyMinScore < 0 {
		errs = append(errs, "scoring.notify_min_score must be >= 0")
	}

	// Rule helpers
	checkRules := func(name string, rules []Rule) {
		for i, r := range rules {
			if r.Tag == "" {
				errs = append(errs, fmt.Sprintf("%s[%d].tag is required", name, i))
			}
			if len(r.Any) == 0 {
				errs = append(errs, fmt.Sprintf("%s[%d].any must have at least 1 term", name, i))
			}
			for j, term := range r.Any {
				if term == "" {
					errs = append(errs, fmt.Sprintf("%s[%d].any[%d] cannot be empty", name, i, j))
				}
			}
		}
	}

	checkPenalties := func(pens []Penalty) {
		for i, p := range pens {
			if p.Reason == "" {
				errs = append(errs, fmt.Sprintf("scoring.penalties[%d].reason is required", i))
			}
			if len(p.Any) == 0 {
				errs = append(errs, fmt.Sprintf("scoring.penalties[%d].any must have at least 1 term", i))
			}
			for j, term := range p.Any {
				if term == "" {
					errs = append(errs, fmt.Sprintf("scoring.penalties[%d].any[%d] cannot be empty", i, j))
				}
			}
		}
	}

	checkRules("scoring.title_rules", cfg.Scoring.TitleRules)
	checkRules("scoring.keyword_rules", cfg.Scoring.KeywordRules)
	checkPenalties(cfg.Scoring.Penalties)

	if len(errs) > 0 {
		return errors.New("config validation failed:\n- " + joinLines(errs))
	}
	return nil
}

func SaveAtomic(path string, cfg Config) error {
	if err := Validate(cfg); err != nil {
		return err
	}

	b, err := yaml.Marshal(&cfg)
	if err != nil {
		return err
	}

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	tmp := path + ".tmp"
	bak := path + ".bak"

	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}

	_ = os.Remove(bak)
	_ = os.Rename(path, bak)

	return os.Rename(tmp, path)
}

func joinLines(lines []string) string {
	out := ""
	for i, s := range lines {
		if i > 0 {
			out += "\n-"
		}
		out += s
	}
	return out
}
