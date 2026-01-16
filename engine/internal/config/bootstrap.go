package config

import (
	"os"
	"path/filepath"
)

func EnsureUserConfig(dataDir string) (string, error) {
	userCfgPath := filepath.Join(dataDir, "config.yml")

	// If user config already exists, keep it.
	if _, err := os.Stat(userCfgPath); err == nil {
		return userCfgPath, nil
	}

	// Otherwise write embedded default config.
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(userCfgPath, DefaultYAML, 0o644); err != nil {
		return "", err
	}
	return userCfgPath, nil
}

func EnsureUserCompaniesConfig(dataDir string) (string, error) {
	path := filepath.Join(dataDir, "companies.yml")

	if _, err := os.Stat(path); err == nil {
		return path, nil
	}

	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(path, DefaultCompaniesYAML, 0o644); err != nil {
		return "", err
	}
	return path, nil
}
