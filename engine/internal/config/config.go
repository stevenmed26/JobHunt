// engine/internal/config/config.go
package config

import (
	"os"

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
		AppPassword      string   `yaml:"app_password" json:"app_password"`
		Mailbox          string   `yaml:"mailbox" json:"mailbox"`
		SearchSubjectAny []string `yaml:"search_subject_any" json:"search_subject_any"`
	} `yaml:"email" json:"email"`
}

func Load(path string) (Config, error) {
	var cfg Config
	b, err := os.ReadFile(path)
	if err != nil {
		return cfg, err
	}
	err = yaml.Unmarshal(b, &cfg)
	return cfg, err
}
