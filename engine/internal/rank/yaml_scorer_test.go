package rank

import (
	"reflect"
	"testing"

	"jobhunt-engine/internal/config"
	"jobhunt-engine/internal/domain"
)

// ─── helpers ─────────────────────────────────────────────────────────────────

func scorer(titleRules, keywordRules []config.Rule, penalties []config.Penalty) YAMLScorer {
	var c config.Config
	c.Scoring.TitleRules = titleRules
	c.Scoring.KeywordRules = keywordRules
	c.Scoring.Penalties = penalties
	return YAMLScorer{Cfg: c}
}

func lead(title, desc string) domain.JobLead {
	return domain.JobLead{Title: title, Description: desc}
}

// ─── YAMLScorer.Score ─────────────────────────────────────────────────────────

func TestYAMLScorerScore(t *testing.T) {
	tests := []struct {
		name      string
		scorer    YAMLScorer
		job       domain.JobLead
		wantScore int
		wantTags  []string
	}{
		{
			name:      "no rules — zero score, no tags",
			scorer:    scorer(nil, nil, nil),
			job:       lead("Software Engineer", ""),
			wantScore: 0,
			wantTags:  nil,
		},
		{
			name: "title rule match",
			scorer: scorer(
				[]config.Rule{{Tag: "engineer", Weight: 10, Any: []string{"engineer"}}},
				nil, nil,
			),
			job:       lead("Senior Software Engineer", ""),
			wantScore: 10,
			wantTags:  []string{"engineer"},
		},
		{
			name: "keyword rule match in description",
			scorer: scorer(
				nil,
				[]config.Rule{{Tag: "golang", Weight: 8, Any: []string{"golang", "go lang"}}},
				nil,
			),
			job:       lead("Backend Developer", "We use Golang and Kubernetes"),
			wantScore: 8,
			wantTags:  []string{"golang"},
		},
		{
			name: "penalty subtracts from score",
			scorer: scorer(
				[]config.Rule{{Tag: "eng", Weight: 20, Any: []string{"engineer"}}},
				nil,
				[]config.Penalty{{Reason: "senior-req", Weight: -10, Any: []string{"10+ years"}}},
			),
			job:       lead("Software Engineer", "Requires 10+ years of experience"),
			wantScore: 10,
			wantTags:  []string{"eng"},
		},
		{
			name: "multiple rules accumulate score",
			scorer: scorer(
				[]config.Rule{{Tag: "eng", Weight: 10, Any: []string{"engineer"}}},
				[]config.Rule{{Tag: "go", Weight: 5, Any: []string{"golang"}}},
				nil,
			),
			job:       lead("Software Engineer", "Strong Golang background required"),
			wantScore: 15,
			wantTags:  []string{"eng", "go"},
		},
		{
			name: "same tag from two rules appears once",
			scorer: scorer(
				[]config.Rule{{Tag: "eng", Weight: 10, Any: []string{"engineer"}}},
				[]config.Rule{{Tag: "eng", Weight: 5, Any: []string{"developer"}}},
				nil,
			),
			job:       lead("Software Engineer and Developer", ""),
			wantScore: 15,
			wantTags:  []string{"eng"}, // deduped
		},
		{
			name: "case insensitive matching",
			scorer: scorer(
				[]config.Rule{{Tag: "ml", Weight: 10, Any: []string{"MACHINE LEARNING"}}},
				nil, nil,
			),
			job:       lead("Machine Learning Engineer", ""),
			wantScore: 10,
			wantTags:  []string{"ml"},
		},
		{
			name: "penalty only — negative score",
			scorer: scorer(
				nil, nil,
				[]config.Penalty{{Reason: "intern", Weight: -20, Any: []string{"intern"}}},
			),
			job:       lead("Software Engineering Intern", ""),
			wantScore: -20,
			wantTags:  nil,
		},
		{
			name: "first needle in any wins — rule applied once",
			scorer: scorer(
				[]config.Rule{{Tag: "fe", Weight: 10, Any: []string{"react", "frontend"}}},
				nil, nil,
			),
			job: lead("React Frontend Developer", ""),
			// "react" matches first — rule applied once even though "frontend" also matches
			wantScore: 10,
			wantTags:  []string{"fe"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			score, tags := tc.scorer.Score(tc.job)
			if score != tc.wantScore {
				t.Errorf("score: got %d, want %d", score, tc.wantScore)
			}
			// nil and empty slice are both "no tags"
			if len(tags) == 0 && len(tc.wantTags) == 0 {
				return
			}
			if !reflect.DeepEqual(tags, tc.wantTags) {
				t.Errorf("tags: got %v, want %v", tags, tc.wantTags)
			}
		})
	}
}

// ─── uniq ─────────────────────────────────────────────────────────────────────

func TestUniq(t *testing.T) {
	tests := []struct {
		in   []string
		want []string
	}{
		{nil, nil},
		{[]string{}, nil},
		{[]string{"a"}, []string{"a"}},
		{[]string{"a", "b", "a"}, []string{"a", "b"}},
		{[]string{"x", "x", "x"}, []string{"x"}},
		{[]string{"a", "b", "c"}, []string{"a", "b", "c"}},
	}

	for _, tc := range tests {
		got := uniq(tc.in)
		if len(got) == 0 && len(tc.want) == 0 {
			continue
		}
		if !reflect.DeepEqual(got, tc.want) {
			t.Errorf("uniq(%v) = %v, want %v", tc.in, got, tc.want)
		}
	}
}
