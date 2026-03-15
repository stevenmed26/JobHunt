package secrets

import (
	"errors"
	"fmt"
	"jobhunt-engine/internal/config"
	"strings"

	"github.com/zalando/go-keyring"
)

const (
	KeyringService   = "jobhunt"
	claudeKeyAccount = "jobhunt:claude:api_key"
)

// ─── IMAP ────────────────────────────────────────────────────────────────────

func GetIMAPPassword(keyringAccount string) (string, error) {
	if strings.TrimSpace(keyringAccount) != "" {
		pw, err := keyring.Get(KeyringService, keyringAccount)
		if err == nil && strings.TrimSpace(pw) != "" {
			return pw, nil
		}
	}
	return "", errors.New("IMAP password not found (set it in keychain or via env)")
}

func SetIMAPPassword(keyringAccount string, password string) error {
	if strings.TrimSpace(keyringAccount) == "" {
		return errors.New("keyring account name is empty")
	}
	if strings.TrimSpace(password) == "" {
		return errors.New("password is empty")
	}
	return keyring.Set(KeyringService, keyringAccount, password)
}

func DeleteIMAPPassword(keyringAccount string) error {
	if strings.TrimSpace(keyringAccount) == "" {
		return errors.New("keyring account name is empty")
	}
	return keyring.Delete(KeyringService, keyringAccount)
}

func IMAPKeyringAccount(cfg config.Config) string {
	return fmt.Sprintf(
		"jobhunt:imap:%s@%s",
		cfg.Email.Username,
		cfg.Email.IMAPHost,
	)
}

// ─── Claude API key ───────────────────────────────────────────────────────────

func GetClaudeAPIKey() (string, error) {
	key, err := keyring.Get(KeyringService, claudeKeyAccount)
	if err != nil {
		return "", fmt.Errorf("Claude API key not found in keyring: %w", err)
	}
	return strings.TrimSpace(key), nil
}

func SetClaudeAPIKey(apiKey string) error {
	apiKey = strings.TrimSpace(apiKey)
	if apiKey == "" {
		return errors.New("API key is empty")
	}
	if !strings.HasPrefix(apiKey, "sk-ant-") {
		return errors.New("API key should start with 'sk-ant-'")
	}
	return keyring.Set(KeyringService, claudeKeyAccount, apiKey)
}

func DeleteClaudeAPIKey() error {
	return keyring.Delete(KeyringService, claudeKeyAccount)
}

// HasClaudeAPIKey returns true if a key is stored, without exposing it.
func HasClaudeAPIKey() bool {
	key, err := keyring.Get(KeyringService, claudeKeyAccount)
	return err == nil && strings.TrimSpace(key) != ""
}
