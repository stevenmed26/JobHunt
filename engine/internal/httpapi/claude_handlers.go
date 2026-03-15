package httpapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"jobhunt-engine/internal/secrets"
)

type ClaudeHandler struct{}

// claudeRequest is what the frontend sends to /api/claude
type claudeRequest struct {
	Model     string          `json:"model"`
	MaxTokens int             `json:"max_tokens"`
	System    string          `json:"system"`
	Messages  []claudeMessage `json:"messages"`
}

type claudeMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// ServeProxy forwards the request to api.anthropic.com, injecting the stored API key.
// The frontend never sees or sends the key — it's fetched from the OS keyring here.
func (h ClaudeHandler) ServeProxy(w http.ResponseWriter, r *http.Request) {
	// Read API key from keyring
	apiKey, err := secrets.GetClaudeAPIKey()
	if err != nil || strings.TrimSpace(apiKey) == "" {
		http.Error(w, `{"error":"Claude API key not set. Add it in Auto Apply → Profile → API Key."}`, http.StatusUnauthorized)
		return
	}

	// Read and validate the incoming request body
	var req claudeRequest
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20)) // 1 MB max
	if err != nil {
		http.Error(w, "failed to read body", http.StatusBadRequest)
		return
	}
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}

	// Always enforce safe defaults
	if req.Model == "" {
		req.Model = "claude-sonnet-4-20250514"
	}
	if req.MaxTokens <= 0 || req.MaxTokens > 2000 {
		req.MaxTokens = 1000
	}

	// Re-marshal to forward cleanly
	fwdBody, err := json.Marshal(req)
	if err != nil {
		http.Error(w, "marshal error", http.StatusInternalServerError)
		return
	}

	// Forward to Anthropic
	upstream, err := http.NewRequestWithContext(r.Context(), http.MethodPost,
		"https://api.anthropic.com/v1/messages", bytes.NewReader(fwdBody))
	if err != nil {
		http.Error(w, fmt.Sprintf("request build error: %v", err), http.StatusInternalServerError)
		return
	}
	upstream.Header.Set("Content-Type", "application/json")
	upstream.Header.Set("x-api-key", apiKey)
	upstream.Header.Set("anthropic-version", "2023-06-01")

	resp, err := http.DefaultClient.Do(upstream)
	if err != nil {
		http.Error(w, fmt.Sprintf("upstream error: %v", err), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	// Relay status + body back verbatim
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}
