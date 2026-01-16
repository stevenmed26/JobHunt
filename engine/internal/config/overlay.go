// config/overlay.go
package config

import (
	"os"

	"gopkg.in/yaml.v3"
)

func OverlayCompanies(cfg *Config, companiesPath string) error {
	b, err := os.ReadFile(companiesPath)
	if err != nil {
		// Missing companies file should not kill startup
		return nil
	}

	var cf CompaniesFile
	if err := yaml.Unmarshal(b, &cf); err != nil {
		return err
	}

	if len(cf.Sources.Greenhouse.Companies) > 0 {
		cfg.Sources.Greenhouse.Companies = cf.Sources.Greenhouse.Companies
	}
	if len(cf.Sources.Lever.Companies) > 0 {
		cfg.Sources.Lever.Companies = cf.Sources.Lever.Companies
	}
	return nil
}
