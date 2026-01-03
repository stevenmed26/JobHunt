// engine/internal/config/config.go
package config

import (
	"os"

	"gopkg.in/yaml.v3"
)

type Rule struct {
	Tag    string   `yaml:"tag"`
	Weight int      `yaml:"weight"`
	Any    []string `yaml:"any"`
}

type Penalty struct {
	Reason string   `yaml:"reason"`
	Weight int      `yaml:"weight"`
	Any    []string `yaml:"any"`
}

type Config struct {
	App struct {
		Port    int    `yaml:"port"`
		DataDir string `yaml:"data_dir"`
	} `yaml:"app"`

	Polling struct {
		EmailSeconds      int `yaml:"email_seconds"`
		FastLaneSeconds   int `yaml:"fast_lane_seconds"`
		NormalLaneSeconds int `yaml:"normal_lane_seconds"`
	} `yaml:"polling"`

	Filters struct {
		RemoteOK       bool     `yaml:"remote_ok"`
		LocationsAllow []string `yaml:"locations_allow"`
		LocationsBlock []string `yaml:"locations_block"`
	} `yaml:"filters"`

	Scoring struct {
		NotifyMinScore int       `yaml:"notify_min_score"`
		TitleRules     []Rule    `yaml:"title_rules"`
		KeywordRules   []Rule    `yaml:"keyword_rules"`
		Penalties      []Penalty `yaml:"penalties"`
	} `yaml:"scoring"`
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
