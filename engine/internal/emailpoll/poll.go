package emailpoll

import (
	"context"
	"database/sql"
	"errors"
	"regexp"
	"strings"
	"time"

	"jobhunt-engine/internal/config"
)

var urlRe = regexp.MustCompile(`https?://[^\s<>"']+`)

func RunOnce(ctx context.Context, db *sql.DB, cfg config.Config) (added int, err error) {
	if !cfg.Email.Enabled {
		return 0, nil
	}
	if cfg.Email.IMAPHost == "" || cfg.Email.Username == "" || cfg.Email.AppPassword == "" {
		return 0, errors.New("email enabled but missing imap_host/username/app_password")
	}

	// TODO: connect to IMAP, search messages, get bodies
	// TODO: extract urls with urlRe
	// TODO: insert jobs with url + firstSeen
	// MVP: return 0 for now until IMAP is wired
	_ = strings.TrimSpace
	_ = time.Now
	return 0, nil
}
