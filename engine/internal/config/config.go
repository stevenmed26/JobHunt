// engine/internal/config/config.go
package config

import (
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

type Rule struct {
	Tag    string   `yaml:"tag" json:"tag"`
	Weight int      `yaml:"weight" json:"weight"`
	Any    []string `yaml:"any" json:"any"`
}

type Penalty struct {
	Reason string   `yaml:"reason" json:"reason"`
	Weight int      `yaml:"weight" json:"weight"`
	Any    []string `yaml:"any" json:"any"`
}

type Company struct {
	Slug string `yaml:"slug" json:"slug"`
	Name string `yaml:"name" json:"name"`
}

type SourceConfig struct {
	Enabled   bool      `yaml:"enabled" json:"enabled"`
	Companies []Company `yaml:"companies" json:"companies"`
}

type Sources struct {
	Greenhouse SourceConfig `yaml:"greenhouse" json:"greenhouse"`
	Lever      SourceConfig `yaml:"lever" json:"lever"`
}

type CompaniesFile struct {
	Sources Sources `yaml:"sources" json:"sources"`
}

type Config struct {
	App struct {
		Port    int    `yaml:"port" json:"port"`
		DataDir string `yaml:"data_dir" json:"data_dir"`
	} `yaml:"app" json:"app"`

	Polling struct {
		EmailSeconds      int `yaml:"email_seconds" json:"email_seconds"`
		FastLaneSeconds   int `yaml:"fast_lane_seconds" json:"fast_lane_seconds"`
		NormalLaneSeconds int `yaml:"normal_lane_seconds" json:"normal_lane_seconds"`
	} `yaml:"polling" json:"polling"`

	Filters struct {
		RemoteOK       bool     `yaml:"remote_ok" json:"remote_ok"`
		LocationsAllow []string `yaml:"locations_allow" json:"locations_allow"`
		LocationsBlock []string `yaml:"locations_block" json:"locations_block"`
	} `yaml:"filters" json:"filters"`

	Scoring struct {
		NotifyMinScore int       `yaml:"notify_min_score" json:"notify_min_score"`
		TitleRules     []Rule    `yaml:"title_rules" json:"title_rules"`
		KeywordRules   []Rule    `yaml:"keyword_rules" json:"keyword_rules"`
		Penalties      []Penalty `yaml:"penalties" json:"penalties"`
	} `yaml:"scoring" json:"scoring"`

	Email struct {
		Enabled          bool     `yaml:"enabled" json:"enabled"`
		IMAPHost         string   `yaml:"imap_host" json:"imap_host"`
		IMAPPort         int      `yaml:"imap_port" json:"imap_port"`
		Username         string   `yaml:"username" json:"username"`
		Mailbox          string   `yaml:"mailbox" json:"mailbox"`
		SearchSubjectAny []string `yaml:"search_subject_any" json:"search_subject_any"`
	} `yaml:"email" json:"email"`

	Sources     Sources `yaml:"sources" json:"sources"`
	SourcesFile string  `yaml:"sources_file" json:"sources_file"`
}

func Load(path string) (Config, error) {
	var cfg Config

	b, err := os.ReadFile(path)
	if err != nil {
		return cfg, err
	}
	if err := yaml.Unmarshal(b, &cfg); err != nil {
		return cfg, err
	}

	// Load companies.yml if configured
	if cfg.SourcesFile != "" {
		if err := loadCompaniesFile(path, &cfg); err != nil {
			return cfg, err
		}
	}

	return cfg, nil
}

func loadCompaniesFile(configPath string, cfg *Config) error {
	companiesPath := cfg.SourcesFile
	if !filepath.IsAbs(companiesPath) {
		companiesPath = filepath.Join(filepath.Dir(configPath), companiesPath)
	}

	b, err := os.ReadFile(companiesPath)
	if err != nil {
		// IMPORTANT: missing companies.yml should NOT break startup
		return nil
	}

	var cf CompaniesFile
	if err := yaml.Unmarshal(b, &cf); err != nil {
		return err
	}

	// Replace only company lists, not user settings
	if len(cf.Sources.Greenhouse.Companies) > 0 {
		cfg.Sources.Greenhouse.Companies = cf.Sources.Greenhouse.Companies
	}
	if len(cf.Sources.Lever.Companies) > 0 {
		cfg.Sources.Lever.Companies = cf.Sources.Lever.Companies
	}

	return nil
}
