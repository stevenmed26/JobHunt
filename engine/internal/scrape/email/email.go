// internal/scrape/email/email.go
package email_scrape

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"log"
	"net/mail"
	"strings"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"
)

// EmailMessage is a minimal representation of an email for scraping.
type EmailMessage struct {
	UID     imap.UID
	From    string
	To      string
	Subject string
	Date    time.Time

	// RawMessage is the full RFC822 message bytes (headers + body).
	// Fetched using BODY.PEEK[] so it won't mark as \Seen.
	RawMessage []byte
}

func GmailTLSConfig() *tls.Config {
	return &tls.Config{
		MinVersion: tls.VersionTLS12,
		ServerName: "imap.gmail.com",
	}
}

// DialAndLoginIMAP connects over TLS and logs in.
func DialAndLoginIMAP(ctx context.Context, addr, username, password string, tlsCfg *tls.Config) (*imapclient.Client, error) {
	if addr == "" {
		return nil, errors.New("imap addr is required")
	}
	if username == "" || password == "" {
		return nil, errors.New("imap username/password is required")
	}
	if tlsCfg == nil {
		tlsCfg = &tls.Config{MinVersion: tls.VersionTLS12}
	}

	// DialTLS expects *imapclient.Options, not *tls.Config.
	c, err := imapclient.DialTLS(addr, &imapclient.Options{
		TLSConfig: tlsCfg,
	})
	if err != nil {
		return nil, fmt.Errorf("imap dial tls: %w", err)
	}

	// Best-effort close on context cancel.
	go func() {
		<-ctx.Done()
		_ = c.Close()
	}()

	// LoginCommand.Wait() returns only error (not (data, err)).
	if err := c.Login(username, password).Wait(); err != nil {
		_ = c.Close()
		return nil, fmt.Errorf("imap login: %w", err)
	}

	return c, nil
}

// SelectInbox selects INBOX.
func SelectInbox(c *imapclient.Client) error {
	if c == nil {
		return errors.New("imap client is nil")
	}
	_, err := c.Select("INBOX", &imap.SelectOptions{ReadOnly: false}).Wait()
	if err != nil {
		return fmt.Errorf("imap select inbox: %w", err)
	}
	return nil
}

// FetchUnseen pulls up to max unseen messages (by UID), including Envelope + full raw RFC822 bytes.
// Uses BODY.PEEK[] so it will NOT set \Seen.
func FetchUnseen(ctx context.Context, c *imapclient.Client, max int) ([]EmailMessage, error) {
	if c == nil {
		return nil, errors.New("imap client is nil")
	}
	if max <= 0 {
		max = 50
	}

	// 3-month cutoff (emails older than this won't even be considered)
	cutoff := time.Now().AddDate(0, -3, 0)

	criteria := &imap.SearchCriteria{
		NotFlag: []imap.Flag{imap.FlagSeen},
		Since:   cutoff, // <-- IMPORTANT
	}

	searchData, err := c.UIDSearch(criteria, nil).Wait()
	if err != nil {
		return nil, fmt.Errorf("imap uid search unseen: %w", err)
	}

	uids := searchData.AllUIDs()
	if len(uids) == 0 {
		return []EmailMessage{}, nil
	}

	// Process newest first
	if len(uids) > 1 {
		for i, j := 0, len(uids)-1; i < j; i, j = i+1, j-1 {
			uids[i], uids[j] = uids[j], uids[i]
		}
	}
	if len(uids) > max {
		uids = uids[:max]
	}

	uidSet := imap.UIDSetNum(uids...)

	bodyAll := &imap.FetchItemBodySection{
		Specifier: imap.PartSpecifierNone,
		Peek:      true,
	}

	fetchOptions := &imap.FetchOptions{
		UID:          true,
		Envelope:     true,
		InternalDate: true,
		BodySection:  []*imap.FetchItemBodySection{bodyAll},
	}

	fetchCmd := c.Fetch(uidSet, fetchOptions)
	defer func() { _ = fetchCmd.Close() }()

	out := make([]EmailMessage, 0, len(uids))

	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}

		msgData := fetchCmd.Next()
		if msgData == nil {
			break
		}

		buf, err := msgData.Collect()
		if err != nil {
			return nil, fmt.Errorf("imap fetch collect: %w", err)
		}

		var em EmailMessage
		em.UID = buf.UID

		if buf.Envelope != nil {
			em.Subject = buf.Envelope.Subject
			em.Date = buf.Envelope.Date
			em.From = joinAddrs(buf.Envelope.From)
			em.To = joinAddrs(buf.Envelope.To)
		}

		if b := buf.FindBodySection(bodyAll); b != nil {
			em.RawMessage = append([]byte(nil), b...)
		}

		if (em.Subject == "" || em.From == "" || em.To == "" || em.Date.IsZero()) && len(em.RawMessage) > 0 {
			subj, from, to, date := parseHeadersFallback(em.RawMessage)
			if em.Subject == "" {
				em.Subject = subj
			}
			if em.From == "" {
				em.From = from
			}
			if em.To == "" {
				em.To = to
			}
			if em.Date.IsZero() && !date.IsZero() {
				em.Date = date
			}
		}

		out = append(out, em)
	}

	if err := fetchCmd.Close(); err != nil {
		return nil, fmt.Errorf("imap fetch close: %w", err)
	}

	return out, nil
}

// MarkSeen sets the \Seen flag for a UID set.
// NOTE: In go-imap v2, Store takes (numSet, storeFlags, options) and returns a *FetchCommand.
// There is no Wait(); you Close() the command to get the final status.
func MarkSeen(c *imapclient.Client, uids []imap.UID) error {
	if c == nil {
		return errors.New("imap client is nil")
	}
	if len(uids) == 0 {
		return nil
	}

	set := imap.UIDSetNum(uids...)

	storeFlags := &imap.StoreFlags{
		Op:     imap.StoreFlagsAdd,
		Silent: true, // don't need the updated flags back
		Flags:  []imap.Flag{imap.FlagSeen},
	}

	cmd := c.Store(set, storeFlags, nil)
	if err := cmd.Close(); err != nil {
		return fmt.Errorf("imap store add seen: %w", err)
	}
	return nil
}

// LogoutAndClose logs out then closes the connection.
func LogoutAndClose(c *imapclient.Client) {
	if c == nil {
		return
	}
	// LogoutCommand.Wait() returns only error (not (data, err)).
	if err := c.Logout().Wait(); err != nil {
		log.Printf("imap logout: %v", err)
	}
	_ = c.Close()
}

func joinAddrs(addrs []imap.Address) string {
	if len(addrs) == 0 {
		return ""
	}
	parts := make([]string, 0, len(addrs))
	for i := range addrs {
		a := &addrs[i]
		addr := strings.TrimSpace(a.Addr())
		if addr == "" {
			addr = strings.TrimSpace(a.Name)
		}
		if addr != "" {
			parts = append(parts, addr)
		}
	}
	return strings.Join(parts, ", ")
}

// Minimal header parsing fallback using net/mail.
// NOTE: This does not robustly handle all RFC2047 encodings; it’s just a safety net.
func parseHeadersFallback(raw []byte) (subject, from, to string, date time.Time) {
	r := strings.NewReader(string(raw))
	msg, err := mail.ReadMessage(r)
	if err != nil {
		return "", "", "", time.Time{}
	}

	h := msg.Header
	subject = h.Get("Subject")
	from = h.Get("From")
	to = h.Get("To")

	if ds := h.Get("Date"); ds != "" {
		if t, err := mail.ParseDate(ds); err == nil {
			date = t
		}
	}

	_, _ = io.Copy(io.Discard, msg.Body)
	return
}
