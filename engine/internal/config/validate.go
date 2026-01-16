package config

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

type Validation struct {
	Errors   []string `json:"errors"`
	Warnings []string `json:"warnings"`
}

func (v *Validation) errf(format string, args ...any) {
	v.Errors = append(v.Errors, fmt.Sprintf(format, args...))
}
func (v *Validation) warnf(format string, args ...any) {
	v.Warnings = append(v.Warnings, fmt.Sprintf(format, args...))
}
func (v Validation) OK() bool { return len(v.Errors) == 0 }

// NormalizeAndValidate returns a normalized copy + validation messages.
// Keep normalization conservative (trim, dedupe, consistent casing) so you don't surprise users.
func NormalizeAndValidate(cfg Config) (Config, Validation) {
	out := cfg
	var res Validation

	// ---------- helpers ----------
	trimDedupe := func(xs []string, lowerKey bool) []string {
		seen := map[string]bool{}
		var ys []string
		for _, x := range xs {
			x = strings.TrimSpace(x)
			if x == "" {
				continue
			}
			key := x
			if lowerKey {
				key = strings.ToLower(key)
			}
			if seen[key] {
				continue
			}
			seen[key] = true
			ys = append(ys, x)
		}
		return ys
	}

	normalizeCompanies := func(in []Company) []Company {
		type key struct{ slug, name string }
		seen := map[key]bool{}
		var outc []Company
		for _, c := range in {
			slug := strings.TrimSpace(c.Slug)
			name := strings.TrimSpace(c.Name)

			// make slugs consistent; Greenhouse/Lever slugs are usually lowercase
			slug = strings.ToLower(slug)

			if slug == "" && name == "" {
				continue
			}
			k := key{slug: slug, name: strings.ToLower(name)}
			if seen[k] {
				continue
			}
			seen[k] = true
			outc = append(outc, Company{Slug: slug, Name: name})
		}
		return outc
	}

	ruleOk := func(r Rule) (ok bool, warnings []string) {
		if strings.TrimSpace(r.Tag) == "" {
			return false, []string{"rule missing tag"}
		}
		if r.Weight == 0 {
			warnings = append(warnings, fmt.Sprintf("rule tag=%q has weight=0 (no effect)", r.Tag))
		}
		if len(r.Any) == 0 {
			return false, []string{fmt.Sprintf("rule tag=%q has empty any[]", r.Tag)}
		}
		// normalize Any values: trim + drop empties
		var cleaned []string
		for _, a := range r.Any {
			a = strings.TrimSpace(a)
			if a != "" {
				cleaned = append(cleaned, a)
			}
		}
		if len(cleaned) == 0 {
			return false, []string{fmt.Sprintf("rule tag=%q any[] only contains blanks", r.Tag)}
		}
		return true, warnings
	}

	penaltyOk := func(p Penalty) (ok bool, warnings []string) {
		if strings.TrimSpace(p.Reason) == "" {
			return false, []string{"penalty missing reason"}
		}
		if p.Weight == 0 {
			warnings = append(warnings, fmt.Sprintf("penalty reason=%q has weight=0 (no effect)", p.Reason))
		}
		if len(p.Any) == 0 {
			return false, []string{fmt.Sprintf("penalty reason=%q has empty any[]", p.Reason)}
		}
		var cleaned []string
		for _, a := range p.Any {
			a = strings.TrimSpace(a)
			if a != "" {
				cleaned = append(cleaned, a)
			}
		}
		if len(cleaned) == 0 {
			return false, []string{fmt.Sprintf("penalty reason=%q any[] only contains blanks", p.Reason)}
		}
		return true, warnings
	}

	// ---------- normalization ----------
	out.Filters.LocationsAllow = trimDedupe(out.Filters.LocationsAllow, true)
	out.Filters.LocationsBlock = trimDedupe(out.Filters.LocationsBlock, true)
	out.Email.SearchSubjectAny = trimDedupe(out.Email.SearchSubjectAny, false) // keep case, email subjects are case-insensitive anyway

	out.Sources.Greenhouse.Companies = normalizeCompanies(out.Sources.Greenhouse.Companies)
	out.Sources.Lever.Companies = normalizeCompanies(out.Sources.Lever.Companies)

	// ---------- validation ----------
	// polling sanity
	if out.Polling.EmailSeconds <= 0 {
		res.errf("polling.email_seconds must be > 0")
	} else if out.Polling.EmailSeconds < 10 {
		res.warnf("polling.email_seconds is very low (%d); may trigger throttling/rate limits", out.Polling.EmailSeconds)
	}
	if out.Polling.FastLaneSeconds <= 0 {
		res.errf("polling.fast_lane_seconds must be > 0")
	}
	if out.Polling.NormalLaneSeconds <= 0 {
		res.errf("polling.normal_lane_seconds must be > 0")
	}

	// filters sanity
	if !out.Filters.RemoteOK && len(out.Filters.LocationsAllow) == 0 {
		res.warnf("filters.remote_ok is false and filters.locations_allow is empty; you may filter out almost everything")
	}
	if len(out.Filters.LocationsAllow) > 50 {
		res.warnf("filters.locations_allow has %d entries; consider tightening it for speed", len(out.Filters.LocationsAllow))
	}

	// allow/block conflicts
	block := map[string]bool{}
	for _, b := range out.Filters.LocationsBlock {
		block[strings.ToLower(b)] = true
	}
	for _, a := range out.Filters.LocationsAllow {
		if block[strings.ToLower(a)] {
			res.warnf("location appears in both allow and block: %q", a)
		}
	}

	// sources enabled check
	// ghOn := out.Sources.Greenhouse.Enabled && len(out.Sources.Greenhouse.Companies) > 0
	// lvOn := out.Sources.Lever.Enabled && len(out.Sources.Lever.Companies) > 0
	// emailOn := out.Email.Enabled

	// if !emailOn && !ghOn && !lvOn {
	// 	res.errf("no sources enabled: enable email or enable greenhouse/lever with at least one company")
	// }

	// greenhouse/lever specifics
	slugRe := regexp.MustCompile(`^[a-z0-9][a-z0-9_-]*$`)
	if out.Sources.Greenhouse.Enabled {
		if len(out.Sources.Greenhouse.Companies) == 0 {
			res.errf("sources.greenhouse.enabled=true but sources.greenhouse.companies is empty")
		}
		for i, c := range out.Sources.Greenhouse.Companies {
			if c.Slug == "" {
				res.errf("sources.greenhouse.companies[%d] missing slug", i)
			} else if !slugRe.MatchString(c.Slug) {
				res.warnf("sources.greenhouse.companies[%d].slug %q looks unusual (expected lowercase slug)", i, c.Slug)
			}
			if strings.TrimSpace(c.Name) == "" {
				res.warnf("sources.greenhouse.companies[%d] slug=%q missing name (UI may look less nice)", i, c.Slug)
			}
		}
	}
	if out.Sources.Lever.Enabled {
		if len(out.Sources.Lever.Companies) == 0 {
			res.errf("sources.lever.enabled=true but sources.lever.companies is empty")
		}
		for i, c := range out.Sources.Lever.Companies {
			if c.Slug == "" {
				res.errf("sources.lever.companies[%d] missing slug", i)
			} else if !slugRe.MatchString(c.Slug) {
				res.warnf("sources.lever.companies[%d].slug %q looks unusual (expected lowercase slug)", i, c.Slug)
			}
			if strings.TrimSpace(c.Name) == "" {
				res.warnf("sources.lever.companies[%d] slug=%q missing name (UI may look less nice)", i, c.Slug)
			}
		}
	}

	// email specifics
	if out.Email.Enabled {
		if strings.TrimSpace(out.Email.IMAPHost) == "" {
			res.errf("email.imap_host is required when email.enabled=true")
		}
		if out.Email.IMAPPort <= 0 || out.Email.IMAPPort > 65535 {
			res.errf("email.imap_port must be a valid port (1-65535) when email.enabled=true")
		}
		if strings.TrimSpace(out.Email.Username) == "" {
			res.errf("email.username is required when email.enabled=true")
		}
		if strings.TrimSpace(out.Email.Mailbox) == "" {
			res.errf("email.mailbox is required when email.enabled=true")
		}
		if len(out.Email.SearchSubjectAny) == 0 {
			res.warnf("email.search_subject_any is empty; email scraping may find nothing")
		}
	}

	// scoring sanity
	if out.Scoring.NotifyMinScore < 0 {
		res.errf("scoring.notify_min_score must be >= 0")
	}
	if len(out.Scoring.TitleRules) == 0 && len(out.Scoring.KeywordRules) == 0 {
		res.warnf("no scoring rules configured (scoring.title_rules and scoring.keyword_rules are empty)")
	}

	// validate each rule/penalty content
	for i, r := range out.Scoring.TitleRules {
		ok, warns := ruleOk(r)
		if !ok {
			res.errf("scoring.title_rules[%d] invalid (tag=%q)", i, r.Tag)
		}
		for _, w := range warns {
			res.warnf("scoring.title_rules[%d]: %s", i, w)
		}
	}
	for i, r := range out.Scoring.KeywordRules {
		ok, warns := ruleOk(r)
		if !ok {
			res.errf("scoring.keyword_rules[%d] invalid (tag=%q)", i, r.Tag)
		}
		for _, w := range warns {
			res.warnf("scoring.keyword_rules[%d]: %s", i, w)
		}
	}
	for i, p := range out.Scoring.Penalties {
		ok, warns := penaltyOk(p)
		if !ok {
			res.errf("scoring.penalties[%d] invalid (reason=%q)", i, p.Reason)
		}
		for _, w := range warns {
			res.warnf("scoring.penalties[%d]: %s", i, w)
		}
	}

	// Keep output stable (nice for UI diffs)
	sort.Strings(res.Errors)
	sort.Strings(res.Warnings)

	return out, res
}
