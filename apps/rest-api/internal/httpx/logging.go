package httpx

import (
	"context"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/go-chi/chi/v5/middleware"
)

type logAttrsKey struct{}

// logAttrs collects fields that inner middlewares (auth) want on the request log line.
type logAttrs struct {
	mu    sync.Mutex
	attrs []slog.Attr
}

// RequestLogger emits exactly one structured line per request. Probe endpoints
// are logged at debug level only, so kubelet probes do not flood the output.
func RequestLogger(log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			la := &logAttrs{}
			ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)

			next.ServeHTTP(ww, r.WithContext(context.WithValue(r.Context(), logAttrsKey{}, la)))

			status := ww.Status()
			if status == 0 { // handler returned without writing anything
				status = http.StatusOK
			}
			attrs := []slog.Attr{
				slog.String("method", r.Method),
				slog.String("path", r.URL.Path),
				slog.Int("status", status),
				slog.Float64("duration_ms", float64(time.Since(start).Microseconds())/1000),
				slog.Int("bytes", ww.BytesWritten()),
				slog.String("request_id", middleware.GetReqID(r.Context())),
			}
			la.mu.Lock()
			attrs = append(attrs, la.attrs...) // sub, roles, ... (never the token)
			la.mu.Unlock()

			level := slog.LevelInfo
			if r.URL.Path == "/healthz" || r.URL.Path == "/readyz" {
				level = slog.LevelDebug
			}
			log.LogAttrs(r.Context(), level, "request", attrs...)
		})
	}
}

// AddLogAttrs attaches fields to the log line of the request that owns ctx.
// The auth middleware uses it to add "sub" and "roles" once a token is verified.
func AddLogAttrs(ctx context.Context, attrs ...slog.Attr) {
	if la, ok := ctx.Value(logAttrsKey{}).(*logAttrs); ok {
		la.mu.Lock()
		la.attrs = append(la.attrs, attrs...)
		la.mu.Unlock()
	}
}
