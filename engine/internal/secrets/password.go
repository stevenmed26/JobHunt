package secrets

import (
	"errors"
	"fmt"
	"jobhunt-engine/internal/config"
	"strings"

	"github.com/zalando/go-keyring"
)

const (
	// “Service” groups your app’s secrets in the OS keychain.
	KeyringService = "jobhunt"
)

func GetIMAPPassword(keyringAccount string) (string, error) {
	// 1) Keyring first (recommended)
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
