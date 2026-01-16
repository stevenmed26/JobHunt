package config

import (
	"fmt"
	"strings"
)

type Validation struct {
	Errors   []string `json:"errors"`
	Warnings []string `json:"warnings"`
}

func (v *Validation) addErr(format string, args ...any) {
	v.Errors = append(v.Errors, fmt.Sprintf(format, args...))
}
func (v *Validation) addWarn(format string, args ...any) {
	v.Warnings = append(v.Warnings, fmt.Sprintf(format, args...))
}
func (v Validation) OK() bool { return len(v.Errors) == 0 }

// NormalizeAndValidate optionally returns a normalized copy.
// If you don’t want auto-normalization yet, just validate in-place.
func NormalizeAndValidate(cfg Config) (Config, Validation) {
	var out = cfg
	var res Validation

	trimList := func(xs []string) []string {
		seen := map[string]bool{}
		var ys []string
		for _, x := range xs {
			x = strings.TrimSpace(x)
			if x == "" {
				continue
			}
			key := strings.ToLower(x)
			if seen[key] {
				continue
			}
			seen[key] = true
			ys = append(ys, x)
		}
		return ys
	}

	// Normalize common lists
	out.Filters.LocationsAllow = trimList(out.Filters.LocationsAllow)
	out.Filters.LocationsBlock = trimList(out.Filters.LocationsBlock)

	// Example: normalize subjects
	out.Email.SearchSubjectAny = trimList(out.Email.SearchSubjectAny)

	// ---- Validation rules ----

	// at least one source enabled
	// if !out.Email.Enabled && !(out.Sources.Greenhouse.Enabled) && !(out.Sources.Lever.Enabled) {
	// 	res.addErr("No sources enabled: enable email scraping, Greenhouse, or Lever")
	// }

	// polling sanity
	if out.Polling.EmailSeconds <= 0 {
		res.addErr("polling.email_seconds must be > 0")
	} else if out.Polling.EmailSeconds < 10 {
		res.addWarn("polling.email_seconds is very low (%d) and may cause rate limits.", out.Polling.EmailSeconds)
	}

	if out.Polling.FastLaneSeconds <= 0 {
		res.addErr("polling.fast_lane_seconds must be > 0")
	}
	if out.Polling.NormalLaneSeconds <= 0 {
		res.addErr("polling.normal_lane_seconds must be > 0")
	}

	// filters sanity
	if !out.Filters.RemoteOK && len(out.Filters.LocationsAllow) == 0 {
		res.addWarn("remote_ok is false and locations_allow is empty; you may filter out almost everything.")
	}
	if len(out.Filters.LocationsAllow) > 50 {
		res.addWarn("locations_allow has %d entries; consider tightening it for faster filtering.", len(out.Filters.LocationsAllow))
	}

	// email required fields if enabled (password not required here; it’s in keychain)
	if out.Email.Enabled {
		if strings.TrimSpace(out.Email.IMAPHost) == "" {
			res.addErr("email.imap_host is required when email.enabled=true")
		}
		if out.Email.IMAPPort == 0 {
			res.addErr("email.imap_port is required when email.enabled=true")
		}
		if strings.TrimSpace(out.Email.Username) == "" {
			res.addErr("email.username is required when email.enabled=true")
		}
		if strings.TrimSpace(out.Email.Mailbox) == "" {
			res.addErr("email.mailbox is required when email.enabled=true")
		}
		if len(out.Email.SearchSubjectAny) == 0 {
			res.addWarn("email.search_subject_any is empty; email scraping may find nothing.")
		}
	}

	// simple conflict check
	blockSet := map[string]bool{}
	for _, b := range out.Filters.LocationsBlock {
		blockSet[strings.ToLower(b)] = true
	}
	for _, a := range out.Filters.LocationsAllow {
		if blockSet[strings.ToLower(a)] {
			res.addWarn("location appears in both allow and block: %q", a)
		}
	}

	return out, res
}
