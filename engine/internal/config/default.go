package config

import _ "embed"

//go:embed default_config.yml
var DefaultYAML []byte
