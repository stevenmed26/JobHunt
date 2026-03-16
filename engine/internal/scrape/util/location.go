package util

import (
	"strings"

	"github.com/PuerkitoBio/goquery"
)

func LooksLikeJunkTitle(t string) bool {
	l := strings.ToLower(t)
	return strings.Contains(l, "view") || strings.Contains(l, "apply")
}

func FindLocation(doc *goquery.Document) string {
	candidates := []string{
		".location",
		".opening .location",
		".opening .location--small",
		".job__location",
		".app-title + .location", // some boards
		"[data-testid='job-location']",
		"[data-testid='location']",
	}

	for _, sel := range candidates {
		if t := CleanText(doc.Find(sel).First().Text()); t != "" {
			return NormalizeLocation(t)
		}
	}

	if v, ok := doc.Find(`meta[property="og:description"]`).Attr("content"); ok {
		if loc := ExtractLocationFromLabeledText(v); loc != "" {
			return NormalizeLocation(loc)
		}
	}

	body := CleanText(doc.Find("body").Text())
	if loc := ExtractLocationFromLabeledText(body); loc != "" {
		return NormalizeLocation(loc)
	}

	return ""
}

// extracts after "Location" patterns in plain text
func ExtractLocationFromLabeledText(s string) string {
	low := strings.ToLower(s)

	// common label forms: "Location", "Locations", "Job Location"
	labels := []string{
		"location:",
		"locations:",
		"job location:",
	}

	for _, lab := range labels {
		if i := strings.Index(low, lab); i >= 0 {
			// take a reasonable slice after the label
			start := i + len(lab)
			rest := strings.TrimSpace(s[start:])

			// stop at newline-ish boundaries if present
			for _, cut := range []string{"\n", "\r", " | ", " · "} {
				if j := strings.Index(rest, cut); j >= 0 {
					rest = rest[:j]
				}
			}

			rest = CleanText(rest)
			if rest != "" && len(rest) <= 80 {
				return rest
			}
		}
	}
	return ""
}
