package config

import (
	"errors"
	"io"
	"os"
	"path/filepath"
)

func EnsureUserConfig(dataDir string, defaultPath string) (string, error) {
	userPath := filepath.Join(dataDir, "config.yml")

	_, err := os.Stat(userPath)
	if err == nil {
		return userPath, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}

	// Copy defaultPath -> userPath
	src, err := os.Open(defaultPath)
	if err != nil {
		return "", err
	}
	defer src.Close()

	dst, err := os.Create(userPath)
	if err != nil {
		return "", err
	}
	defer dst.Close()

	if _, err := io.Copy(dst, src); err != nil {
		return "", err
	}
	return userPath, nil
}
