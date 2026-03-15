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

type scrapedField struct {
	Selector      string         `json:"selector"`
	Label         string         `json:"label"`
	Type          string         `json:"type"`
	Required      bool           `json:"required"`
	Options       []selectOption `json:"options"`
	Value         string         `json:"value"`
	IsReactSelect bool           `json:"isReactSelect,omitempty"`
}

type selectOption struct {
	Value string `json:"value"`
	Label string `json:"label"`
}

type fillField struct {
	Selector      string `json:"selector"`
	Label         string `json:"label"`
	Type          string `json:"type"`
	Value         string `json:"value"`
	IsFile        bool   `json:"isFile,omitempty"`
	IsReactSelect bool   `json:"isReactSelect,omitempty"`
}

// ─── POST /api/apply/scrape ────────────────────────────────────────────────────

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

type fillRequest struct {
	JobID  int64       `json:"jobId"`
	URL    string      `json:"url"`
	Fields []fillField `json:"fields"`
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

	// Filter out empty fields — no resume file injection needed
	var fields []fillField
	for _, f := range req.Fields {
		if strings.TrimSpace(f.Value) == "" {
			continue
		}
		fields = append(fields, f)
	}

	jobPayload := map[string]any{
		"url":    req.URL,
		"fields": fields,
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
	}()

	writeJSON(w, map[string]any{"ok": true, "pid": cmd.Process.Pid})
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
