package util

import "strings"

func CleanText(s string) string {
	s = strings.ReplaceAll(s, "\u00a0", " ")
	s = strings.Join(strings.Fields(s), " ")
	return strings.TrimSpace(s)
}

func NormalizeLocation(loc string) string {
	loc = CleanText(loc)
	if loc == "" {
		return ""
	}

	loc = strings.TrimPrefix(loc, "Location:")
	loc = strings.TrimPrefix(loc, "LOCATIONS:")
	loc = strings.TrimSpace(loc)

	parts := strings.Split(loc, ",")
	seen := map[string]bool{}
	var out []string
	for _, p := range parts {
		p = CleanText(p)
		if p == "" {
			continue
		}
		k := strings.ToLower(p)
		if seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, p)
	}
	return strings.Join(out, ", ")
}

func InferWorkModeFromText(location, title, desc string) string {
	blob := strings.ToLower(strings.Join([]string{location, title, desc}, " "))

	switch {
	case strings.Contains(blob, "remote"):
		return "Remote"
	case strings.Contains(blob, "hybrid"):
		return "Hybrid"
	case strings.Contains(blob, "on-site") || strings.Contains(blob, "onsite") || strings.Contains(blob, "on site"):
		return "Onsite"
	default:
		return "Unknown"
	}
}
