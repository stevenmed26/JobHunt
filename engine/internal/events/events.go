package events

import (
	"encoding/json"
	"time"
)

type Event struct {
	Type      string          `json:"type"`
	Version   int             `json:"v"`
	At        time.Time       `json:"at"`
	RequestID string          `json:"request_id,omitempty"`
	Data      json.RawMessage `json:"data,omitempty"`
}

func MakeEvent(reqID, typ string, v int, data any) string {
	var raw json.RawMessage
	if data != nil {
		b, _ := json.Marshal(data)
		raw = b
	}
	e := Event{
		Type:      typ,
		Version:   v,
		At:        time.Now().UTC(),
		RequestID: reqID,
		Data:      raw,
	}
	b, _ := json.Marshal(e)
	return string(b)
}
