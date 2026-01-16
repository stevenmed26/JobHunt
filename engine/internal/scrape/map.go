package scrape

import (
	"jobhunt-engine/internal/config"
	"jobhunt-engine/internal/scrape/greenhouse"
	"jobhunt-engine/internal/scrape/lever"
)

func MapGreenhouseCompanies(in []config.Company) []greenhouse.Company {
	out := make([]greenhouse.Company, 0, len(in))
	for _, c := range in {
		out = append(out, greenhouse.Company{
			Slug: c.Slug,
			Name: c.Name,
		})
	}
	return out
}

func MapLeverCompanies(in []config.Company) []lever.Company {
	out := make([]lever.Company, 0, len(in))
	for _, c := range in {
		out = append(out, lever.Company{
			Slug: c.Slug,
			Name: c.Name,
		})
	}
	return out
}
