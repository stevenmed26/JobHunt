package scrape

import (
	"testing"

	"jobhunt-engine/internal/config"
	"jobhunt-engine/internal/domain"
)

// ─── helpers ─────────────────────────────────────────────────────────────────

func rule(tag string, weight int, any ...string) config.Rule {
	return config.Rule{Tag: tag, Weight: weight, Any: any}
}

func job(title, location string) domain.JobLead {
	return domain.JobLead{Title: title, LocationRaw: location}
}

func jobWithDesc(title, location, desc string) domain.JobLead {
	return domain.JobLead{Title: title, LocationRaw: location, Description: desc}
}

func cfgWithRules(rules ...config.Rule) config.Config {
	var c config.Config
	c.Scoring.TitleRules = rules
	return c
}

// ─── ShouldKeepJob ────────────────────────────────────────────────────────────

func TestShouldKeepJob(t *testing.T) {
	tests := []struct {
		name       string
		cfg        config.Config
		job        domain.JobLead
		wantKeep   bool
		wantReason string
	}{
		{
			name: "passes location and keyword",
			cfg: func() config.Config {
				c := cfgWithRules(rule("eng", 10, "engineer"))
				c.Filters.LocationsAllow = []string{"texas"}
				return c
			}(),
			job:      job("Software Engineer", "Austin, Texas"),
			wantKeep: true,
		},
		{
			name: "blocked by location",
			cfg: func() config.Config {
				c := cfgWithRules(rule("eng", 10, "engineer"))
				c.Filters.LocationsBlock = []string{"london"}
				return c
			}(),
			job:        job("Software Engineer", "London, UK"),
			wantKeep:   false,
			wantReason: "location",
		},
		{
			// "Remote" with remote_ok=false is blocked at the location stage
			// before keyword matching even runs — reason is "location", not "no_keyword_match".
			// To test the keyword path, use a non-remote location that passes location checks.
			name:       "no keyword match — location passes, keyword fails",
			cfg:        cfgWithRules(rule("eng", 10, "engineer")),
			job:        job("Marketing Manager", "Dallas, TX"),
			wantKeep:   false,
			wantReason: "no_keyword_match",
		},
		{
			name: "remote allowed when remote_ok=true",
			cfg: func() config.Config {
				c := cfgWithRules(rule("eng", 10, "engineer"))
				c.Filters.RemoteOK = true
				return c
			}(),
			job:      job("Software Engineer", "Remote"),
			wantKeep: true,
		},
		{
			name:       "remote rejected when remote_ok=false",
			cfg:        cfgWithRules(rule("eng", 10, "engineer")),
			job:        job("Software Engineer", "Remote"),
			wantKeep:   false,
			wantReason: "location",
		},
		{
			name:     "empty allow list permits any non-remote location",
			cfg:      cfgWithRules(rule("eng", 10, "engineer")),
			job:      job("Software Engineer", "Dallas, TX"),
			wantKeep: true,
		},
		{
			name:     "keyword match in description",
			cfg:      cfgWithRules(rule("go", 10, "golang")),
			job:      jobWithDesc("Backend Developer", "Remote", "We use Golang and Kubernetes"),
			wantKeep: false, // remote_ok is false in default cfg
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			keep, reason := ShouldKeepJob(tc.cfg, tc.job)
			if keep != tc.wantKeep {
				t.Errorf("keep: got %v, want %v", keep, tc.wantKeep)
			}
			if tc.wantReason != "" && reason != tc.wantReason {
				t.Errorf("reason: got %q, want %q", reason, tc.wantReason)
			}
		})
	}
}

// ─── passesLocation ───────────────────────────────────────────────────────────

func TestPassesLocation(t *testing.T) {
	tests := []struct {
		name string
		cfg  config.Config
		job  domain.JobLead
		want bool
	}{
		{
			name: "blocklist wins over allowlist",
			cfg: func() config.Config {
				var c config.Config
				c.Filters.LocationsAllow = []string{"texas"}
				c.Filters.LocationsBlock = []string{"texas"}
				return c
			}(),
			job:  job("Engineer", "Dallas, Texas"),
			want: false,
		},
		{
			name: "remote in title triggers remote detection",
			cfg:  func() config.Config { var c config.Config; c.Filters.RemoteOK = true; return c }(),
			job:  job("Remote Software Engineer", "New York"),
			want: true,
		},
		{
			name: "remote in description triggers remote detection",
			cfg:  func() config.Config { var c config.Config; c.Filters.RemoteOK = true; return c }(),
			job:  jobWithDesc("Engineer", "New York", "This is a fully remote position"),
			want: true,
		},
		{
			name: "allow match in location",
			cfg:  func() config.Config { var c config.Config; c.Filters.LocationsAllow = []string{"austin"}; return c }(),
			job:  job("Engineer", "Austin, TX"),
			want: true,
		},
		{
			name: "allow list with no match",
			cfg:  func() config.Config { var c config.Config; c.Filters.LocationsAllow = []string{"austin"}; return c }(),
			job:  job("Engineer", "Chicago, IL"),
			want: false,
		},
		{
			name: "empty blocklist and allowlist — allow everything",
			cfg:  config.Config{},
			job:  job("Engineer", "Anywhere"),
			want: true,
		},
		{
			name: "blocklist entry matches location substring",
			cfg:  func() config.Config { var c config.Config; c.Filters.LocationsBlock = []string{"new york"}; return c }(),
			job:  job("Engineer", "New York City, NY"),
			want: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := passesLocation(tc.cfg, tc.job)
			if got != tc.want {
				t.Errorf("passesLocation = %v, want %v", got, tc.want)
			}
		})
	}
}

// ─── matchesAnyRule ───────────────────────────────────────────────────────────

func TestMatchesAnyRule(t *testing.T) {
	tests := []struct {
		name string
		cfg  config.Config
		job  domain.JobLead
		want bool
	}{
		{
			name: "title rule match",
			cfg:  cfgWithRules(rule("eng", 10, "engineer")),
			job:  job("Senior Software Engineer", ""),
			want: true,
		},
		{
			name: "keyword rule match in description",
			cfg: func() config.Config {
				var c config.Config
				c.Scoring.KeywordRules = []config.Rule{rule("go", 10, "golang")}
				return c
			}(),
			job:  jobWithDesc("Backend Developer", "", "Experience with Golang required"),
			want: true,
		},
		{
			name: "no rules — no match",
			cfg:  config.Config{},
			job:  job("Software Engineer", ""),
			want: false,
		},
		{
			name: "case insensitive match",
			cfg:  cfgWithRules(rule("eng", 10, "ENGINEER")),
			job:  job("software engineer", ""),
			want: true,
		},
		{
			name: "blank needle skipped",
			cfg:  cfgWithRules(rule("empty", 10, "", "  ")),
			job:  job("Software Engineer", ""),
			want: false,
		},
		{
			name: "multiple any terms — first match wins",
			cfg:  cfgWithRules(rule("eng", 10, "developer", "engineer")),
			job:  job("Software Developer", ""),
			want: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := matchesAnyRule(tc.cfg, tc.job)
			if got != tc.want {
				t.Errorf("matchesAnyRule = %v, want %v", got, tc.want)
			}
		})
	}
}
