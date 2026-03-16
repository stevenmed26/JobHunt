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

// LLMHandler proxies AI completion requests through Groq's OpenAI-compatible API.
// The frontend sends a simple {system, messages} payload; the handler injects
// the stored API key and maps to Groq's chat completions format.
type LLMHandler struct{}

// llmRequest is what the frontend sends to /api/llm
type llmRequest struct {
	System    string       `json:"system"`
	Messages  []llmMessage `json:"messages"`
	MaxTokens int          `json:"max_tokens"`
}

type llmMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// groqRequest is Groq's OpenAI-compatible chat completions format
type groqRequest struct {
	Model       string       `json:"model"`
	Messages    []llmMessage `json:"messages"`
	MaxTokens   int          `json:"max_tokens"`
	Temperature float64      `json:"temperature"`
}

// ServeProxy forwards completions to Groq, injecting the stored API key.
// The frontend never sees or sends the key — it's fetched from the OS keyring.
func (h LLMHandler) ServeProxy(w http.ResponseWriter, r *http.Request) {
	apiKey, err := secrets.GetGroqAPIKey()
	if err != nil || strings.TrimSpace(apiKey) == "" {
		http.Error(w, `{"error":"Groq API key not set. Add it in Auto Apply -> Profile -> API Key."}`, http.StatusUnauthorized)
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		http.Error(w, "failed to read body", http.StatusBadRequest)
		return
	}
	var req llmRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}

	maxTokens := req.MaxTokens
	if maxTokens <= 0 || maxTokens > 2000 {
		maxTokens = 1500
	}

	// Groq uses OpenAI messages array — prepend system prompt as a system-role entry
	msgs := make([]llmMessage, 0, len(req.Messages)+1)
	if strings.TrimSpace(req.System) != "" {
		msgs = append(msgs, llmMessage{Role: "system", Content: req.System})
	}
	msgs = append(msgs, req.Messages...)

	fwdBody, _ := json.Marshal(groqRequest{
		Model:       "llama-3.3-70b-versatile",
		Messages:    msgs,
		MaxTokens:   maxTokens,
		Temperature: 0.3,
	})

	upstream, err := http.NewRequestWithContext(r.Context(), http.MethodPost,
		"https://api.groq.com/openai/v1/chat/completions", bytes.NewReader(fwdBody))
	if err != nil {
		http.Error(w, fmt.Sprintf("request build error: %v", err), http.StatusInternalServerError)
		return
	}
	upstream.Header.Set("Content-Type", "application/json")
	upstream.Header.Set("Authorization", "Bearer "+apiKey)

	resp, err := http.DefaultClient.Do(upstream)
	if err != nil {
		http.Error(w, fmt.Sprintf("upstream error: %v", err), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		http.Error(w, "failed to read upstream response", http.StatusBadGateway)
		return
	}

	// Groq returns OpenAI format: choices[0].message.content
	// Normalize to { "text": "..." } so the frontend is provider-agnostic
	if resp.StatusCode == http.StatusOK {
		var groqResp struct {
			Choices []struct {
				Message struct {
					Content string `json:"content"`
				} `json:"message"`
			} `json:"choices"`
		}
		if json.Unmarshal(respBody, &groqResp) == nil && len(groqResp.Choices) > 0 {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]string{
				"text": groqResp.Choices[0].Message.Content,
			})
			return
		}
	}

	// Relay error response verbatim
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(respBody)
}
