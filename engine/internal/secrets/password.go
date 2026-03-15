package secrets

import (
	"errors"
	"fmt"
	"jobhunt-engine/internal/config"
	"strings"

	"github.com/zalando/go-keyring"
)

const (
	KeyringService = "jobhunt"
	groqKeyAccount = "jobhunt:groq:api_key"
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

// ─── Groq API key ─────────────────────────────────────────────────────────────

func GetGroqAPIKey() (string, error) {
	key, err := keyring.Get(KeyringService, groqKeyAccount)
	if err != nil {
		return "", fmt.Errorf("Groq API key not found in keyring: %w", err)
	}
	return strings.TrimSpace(key), nil
}

func SetGroqAPIKey(apiKey string) error {
	apiKey = strings.TrimSpace(apiKey)
	if apiKey == "" {
		return errors.New("API key is empty")
	}
	if !strings.HasPrefix(apiKey, "gsk_") {
		return errors.New("Groq API keys start with 'gsk_'")
	}
	return keyring.Set(KeyringService, groqKeyAccount, apiKey)
}

func DeleteGroqAPIKey() error {
	return keyring.Delete(KeyringService, groqKeyAccount)
}

// HasGroqAPIKey returns true if a key is stored, without exposing the value.
func HasGroqAPIKey() bool {
	key, err := keyring.Get(KeyringService, groqKeyAccount)
	return err == nil && strings.TrimSpace(key) != ""
}
