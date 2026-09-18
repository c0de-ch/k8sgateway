package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/c0de-ch/k8sgateway/apps/rest-api/internal/auth"
	"github.com/c0de-ch/k8sgateway/apps/rest-api/internal/httpx"
)

type handlers struct{ d Deps }

func (h *handlers) healthz(w http.ResponseWriter, _ *http.Request) {
	httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *handlers) readyz(w http.ResponseWriter, _ *http.Request) {
	if err := h.d.Ready(); err != nil {
		httpx.WriteJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "not_ready", "reason": err.Error()})
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}

func (h *handlers) public(w http.ResponseWriter, _ *http.Request) {
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"message": "This endpoint is public - no token required.",
		"hint":    "Send 'Authorization: Bearer <access token>' to /api/me to see who you are.",
		"time":    time.Now().UTC().Format(time.RFC3339),
	})
}

// me shows what the API learned from the access token. The shape is fixed:
// {sub, name, preferred_username, email, roles[], claims{}}.
func (h *handlers) me(w http.ResponseWriter, r *http.Request) {
	p, _ := auth.FromContext(r.Context())
	str := func(k string) string { s, _ := p.Claims[k].(string); return s }
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"sub":                p.Subject,
		"name":               str("name"),
		"preferred_username": str("preferred_username"),
		"email":              str("email"),
		"roles":              p.Roles,
		"claims":             p.Claims,
	})
}

// listOrders returns the caller's own orders; admins see everyone's via /api/admin/orders.
func (h *handlers) listOrders(w http.ResponseWriter, r *http.Request) {
	p, _ := auth.FromContext(r.Context())
	httpx.WriteJSON(w, http.StatusOK, h.d.Orders.ByOwner(p.Username()))
}

func (h *handlers) createOrder(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Item     string `json:"item"`
		Quantity int    `json:"quantity"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&in); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "bad_request", "body must be JSON {\"item\": string, \"quantity\": int}")
		return
	}
	in.Item = strings.TrimSpace(in.Item)
	switch {
	case in.Item == "" || len(in.Item) > 100:
		httpx.WriteError(w, http.StatusBadRequest, "bad_request", "item must be 1-100 characters")
		return
	case in.Quantity < 1 || in.Quantity > 1000:
		httpx.WriteError(w, http.StatusBadRequest, "bad_request", "quantity must be between 1 and 1000")
		return
	}
	p, _ := auth.FromContext(r.Context())
	httpx.WriteJSON(w, http.StatusCreated, h.d.Orders.Create(in.Item, in.Quantity, p.Username()))
}

func (h *handlers) stats(w http.ResponseWriter, _ *http.Request) {
	n, users := h.d.Orders.Stats()
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"orders":        n,
		"users":         users,
		"uptimeSeconds": int(time.Since(h.d.Started).Seconds()),
	})
}

func (h *handlers) allOrders(w http.ResponseWriter, _ *http.Request) {
	httpx.WriteJSON(w, http.StatusOK, h.d.Orders.All())
}
