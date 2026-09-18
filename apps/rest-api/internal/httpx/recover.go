package httpx

import (
	"errors"
	"log/slog"
	"net/http"
	"runtime/debug"
)

// Recoverer turns a panic into a 500 JSON response. The stack trace goes to the
// server log only - a client never sees internals.
func Recoverer(log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if rec := recover(); rec != nil {
					if err, ok := rec.(error); ok && errors.Is(err, http.ErrAbortHandler) {
						panic(rec) // net/http uses this to abort a response on purpose
					}
					log.Error("panic recovered", "panic", rec, "stack", string(debug.Stack()))
					WriteError(w, http.StatusInternalServerError, "internal_error", "internal server error")
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}
