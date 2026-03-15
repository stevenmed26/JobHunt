package httpapi

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type ApplyHandler struct {
	DB      *sql.DB
	DataDir string
}

// ─── Shared types ──────────────────────────────────────────────────────────────

// scrapedField is what filler.js --scrape writes per field
type scrapedField struct {
	Selector      string         `json:"selector"`
	Label         string         `json:"label"`
	Type          string         `json:"type"` // text|email|tel|select|textarea|file|react-select
	Required      bool           `json:"required"`
	Options       []selectOption `json:"options"` // non-empty for select/react-select
	Value         string         `json:"value"`   // filled in by engine before returning to frontend
	IsReactSelect bool           `json:"isReactSelect,omitempty"`
}

type selectOption struct {
	Value string `json:"value"`
	Label string `json:"label"`
}

// fillField is what the frontend sends back per field for the fill run
type fillField struct {
	Selector      string `json:"selector"`
	Label         string `json:"label"`
	Type          string `json:"type"`
	Value         string `json:"value"`
	IsFile        bool   `json:"isFile,omitempty"`
	IsReactSelect bool   `json:"isReactSelect,omitempty"`
}

// ─── POST /api/apply/scrape ────────────────────────────────────────────────────
//
// Spawns filler.js --scrape, waits for it to finish, reads the result file,
// and returns the scraped fields to the frontend for Groq to fill.

type scrapeRequest struct {
	JobID   int64  `json:"jobId"`
	URL     string `json:"url"`
	ATSType string `json:"atsType"`
}

func (h ApplyHandler) Scrape(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 64<<10))
	if err != nil {
		http.Error(w, "failed to read body", http.StatusBadRequest)
		return
	}
	var req scrapeRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(req.URL) == "" {
		http.Error(w, "url is required", http.StatusBadRequest)
		return
	}

	tmpDir := h.DataDir
	if tmpDir == "" {
		tmpDir = os.TempDir()
	}

	outFile := filepath.Join(tmpDir,
		fmt.Sprintf("jobhunt-scrape-%d-%d.json", req.JobID, time.Now().UnixMilli()))
	defer os.Remove(outFile)

	fillerScript, nodeExe, err := findFillerAndNode()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	cmd := exec.Command(nodeExe, fillerScript, "--scrape", "--url", req.URL, "--out", outFile)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Dir = filepath.Dir(fillerScript)

	// Scrape runs synchronously — we wait for it (30 second timeout)
	done := make(chan error, 1)
	if err := cmd.Start(); err != nil {
		http.Error(w, "failed to start filler: "+err.Error(), http.StatusInternalServerError)
		return
	}
	go func() { done <- cmd.Wait() }()

	select {
	case err := <-done:
		if err != nil {
			http.Error(w, "filler scrape failed: "+err.Error(), http.StatusInternalServerError)
			return
		}
	case <-time.After(45 * time.Second):
		_ = cmd.Process.Kill()
		http.Error(w, "filler scrape timed out", http.StatusGatewayTimeout)
		return
	}

	// Read the result file
	resultBytes, err := os.ReadFile(outFile)
	if err != nil {
		http.Error(w, "failed to read scrape result: "+err.Error(), http.StatusInternalServerError)
		return
	}

	var result struct {
		URL    string         `json:"url"`
		Fields []scrapedField `json:"fields"`
		Error  string         `json:"error,omitempty"`
	}
	if err := json.Unmarshal(resultBytes, &result); err != nil {
		http.Error(w, "failed to parse scrape result: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if result.Error != "" {
		http.Error(w, "scrape error: "+result.Error, http.StatusInternalServerError)
		return
	}

	writeJSON(w, map[string]any{
		"ok":     true,
		"jobId":  req.JobID,
		"fields": result.Fields,
	})
}

// ─── POST /api/apply/fill ──────────────────────────────────────────────────────
//
// Spawns filler.js --fill with the reviewed fields. Runs detached so the
// browser window stays open for the user.

type fillRequest struct {
	JobID         int64       `json:"jobId"`
	URL           string      `json:"url"`
	ResumePdfPath string      `json:"resumePdfPath"`
	ResumeText    string      `json:"resumeText"`
	Fields        []fillField `json:"fields"`
}

func (h ApplyHandler) Fill(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 512<<10))
	if err != nil {
		http.Error(w, "failed to read body", http.StatusBadRequest)
		return
	}
	var req fillRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(req.URL) == "" {
		http.Error(w, "url is required", http.StatusBadRequest)
		return
	}

	tmpDir := h.DataDir
	if tmpDir == "" {
		tmpDir = os.TempDir()
	}

	// Resolve resume path
	resumePath, resumeTempWritten, err := resolveResumePath(req.ResumePdfPath, req.ResumeText, tmpDir)
	if err != nil {
		http.Error(w, "resume error: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Build fill fields — inject resume into the file field
	fillFields := buildFillFields(req.Fields, resumePath)

	jobPayload := map[string]any{
		"url":    req.URL,
		"fields": fillFields,
	}
	jobJSON, _ := json.MarshalIndent(jobPayload, "", "  ")

	jobFilePath := filepath.Join(tmpDir,
		fmt.Sprintf("jobhunt-fill-%d-%d.json", req.JobID, time.Now().UnixMilli()))
	if err := os.WriteFile(jobFilePath, jobJSON, 0o600); err != nil {
		http.Error(w, "failed to write job file: "+err.Error(), http.StatusInternalServerError)
		return
	}

	fillerScript, nodeExe, err := findFillerAndNode()
	if err != nil {
		_ = os.Remove(jobFilePath)
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	cmd := exec.Command(nodeExe, fillerScript, "--fill", "--job", jobFilePath)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Dir = filepath.Dir(fillerScript)

	if err := cmd.Start(); err != nil {
		_ = os.Remove(jobFilePath)
		http.Error(w, "failed to launch filler: "+err.Error(), http.StatusInternalServerError)
		return
	}

	go func() {
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()
		select {
		case <-done:
		case <-time.After(15 * time.Minute):
		}
		_ = os.Remove(jobFilePath)
		if resumeTempWritten && resumePath != "" {
			_ = os.Remove(resumePath)
		}
	}()

	writeJSON(w, map[string]any{"ok": true, "pid": cmd.Process.Pid})
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

func resolveResumePath(pdfPath, resumeText, tmpDir string) (path string, tempWritten bool, err error) {
	if strings.TrimSpace(pdfPath) != "" {
		if _, statErr := os.Stat(pdfPath); statErr == nil {
			return pdfPath, false, nil
		}
		// PDF path stale — fall through
	}
	if strings.TrimSpace(resumeText) != "" {
		p := filepath.Join(tmpDir, fmt.Sprintf("jobhunt-resume-%d.txt", time.Now().UnixMilli()))
		if writeErr := os.WriteFile(p, []byte(resumeText), 0o600); writeErr != nil {
			return "", false, writeErr
		}
		return p, true, nil
	}
	return "", false, nil
}

func buildFillFields(fields []fillField, resumePath string) []fillField {
	out := make([]fillField, 0, len(fields)+1)
	resumeInjected := false

	for _, f := range fields {
		if f.Type == "file" || f.IsFile {
			if resumePath != "" {
				out = append(out, fillField{
					Selector: f.Selector,
					Label:    f.Label,
					Type:     "file",
					Value:    resumePath,
					IsFile:   true,
				})
				resumeInjected = true
			}
			continue
		}
		if strings.TrimSpace(f.Value) == "" {
			continue
		}
		out = append(out, f)
	}

	// Append resume if no file field was found but we have a path
	if !resumeInjected && resumePath != "" {
		out = append(out, fillField{
			Selector: "input[type=\"file\"]",
			Label:    "Resume",
			Type:     "file",
			Value:    resumePath,
			IsFile:   true,
		})
	}
	return out
}

func findFillerAndNode() (script string, node string, err error) {
	script, err = findFillerScript()
	if err != nil {
		return "", "", err
	}
	node = findNode()
	if node == "" {
		return "", "", fmt.Errorf("Node.js not found — install from https://nodejs.org")
	}
	return script, node, nil
}

func findFillerScript() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("can't find own executable: %w", err)
	}
	dir := filepath.Dir(exe)

	candidates := []string{
		filepath.Join(dir, "filler", "filler.js"),
		filepath.Join(dir, "..", "filler", "filler.js"),
		filepath.Join(dir, "..", "..", "filler", "filler.js"),
		filepath.Join(dir, "..", "resources", "filler", "filler.js"),
		filepath.Join(dir, "filler.js"),
	}
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			return filepath.Abs(c)
		}
	}
	return "", fmt.Errorf("filler.js not found (checked: %v)", candidates)
}

func findNode() string {
	for _, name := range []string{"node", "node.exe"} {
		if p, err := exec.LookPath(name); err == nil {
			return p
		}
	}
	if runtime.GOOS == "windows" {
		for _, p := range []string{
			`C:\Program Files\nodejs\node.exe`,
			`C:\Program Files (x86)\nodejs\node.exe`,
		} {
			if _, err := os.Stat(p); err == nil {
				return p
			}
		}
	}
	return ""
}
