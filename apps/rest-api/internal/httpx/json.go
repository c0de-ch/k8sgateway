// Package httpx holds the small HTTP helpers shared by the auth middleware and
// the handlers: JSON writers, the per-request log line and panic recovery.
package httpx

import (
	"encoding/json"
	"net/http"
)

// WriteJSON encodes v as the response body with the given status code.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// WriteError writes the error shape used everywhere in this API:
// {"error": "<code>", "error_description": "<human readable>"}.
func WriteError(w http.ResponseWriter, status int, code, description string) {
	WriteJSON(w, status, map[string]string{"error": code, "error_description": description})
}
