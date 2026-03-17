package httpapi

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// CoverLetterHandler saves a generated cover letter as a plain-text file.
// PDF generation requires external dependencies; .txt is universally openable
// and can be copy-pasted into any application form.

type CoverLetterHandler struct{}

type saveCoverLetterReq struct {
	FirstName   string `json:"firstName"`
	LastName    string `json:"lastName"`
	CompanyName string `json:"companyName"`
	Content     string `json:"content"`
	SaveDir     string `json:"saveDir"` // absolute path chosen by user
}

// POST /api/cover-letter/save
func (h CoverLetterHandler) Save(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 512<<10))
	if err != nil {
		http.Error(w, "failed to read body", http.StatusBadRequest)
		return
	}

	var req saveCoverLetterReq
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
		return
	}

	if strings.TrimSpace(req.Content) == "" {
		http.Error(w, "content is required", http.StatusBadRequest)
		return
	}

	// Determine save directory
	saveDir := strings.TrimSpace(req.SaveDir)
	if saveDir == "" {
		// Default to user's Documents folder
		home, err := os.UserHomeDir()
		if err != nil {
			saveDir = "."
		} else {
			saveDir = filepath.Join(home, "Documents", "JobHunt", "CoverLetters")
		}
	}
	if err := os.MkdirAll(saveDir, 0o755); err != nil {
		http.Error(w, "failed to create directory: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Build filename: FirstName_LastName_Cover_Letter_CompanyName.txt
	filename := buildFilename(req.FirstName, req.LastName, req.CompanyName)
	filePath := filepath.Join(saveDir, filename)

	// If file already exists, append timestamp to avoid overwriting
	if _, err := os.Stat(filePath); err == nil {
		ext := filepath.Ext(filename)
		base := strings.TrimSuffix(filename, ext)
		filePath = filepath.Join(saveDir, fmt.Sprintf("%s_%d%s", base, time.Now().Unix(), ext))
	}

	if err := os.WriteFile(filePath, []byte(req.Content), 0o644); err != nil {
		http.Error(w, "failed to write file: "+err.Error(), http.StatusInternalServerError)
		return
	}

	writeJSON(w, map[string]any{
		"ok":   true,
		"path": filePath,
	})
}

// buildFilename sanitises name parts and builds a safe filename.
// e.g. "Steven", "Mediterraneo", "GitLab" → "Steven_Mediterraneo_Cover_Letter_GitLab.txt"
func buildFilename(first, last, company string) string {
	safe := regexp.MustCompile(`[^a-zA-Z0-9_\-]`)

	sanitise := func(s string) string {
		s = strings.TrimSpace(s)
		s = strings.ReplaceAll(s, " ", "_")
		s = safe.ReplaceAllString(s, "")
		if s == "" {
			return "Unknown"
		}
		return s
	}

	return fmt.Sprintf("%s_%s_Cover_Letter_%s.txt",
		sanitise(first),
		sanitise(last),
		sanitise(company),
	)
}
