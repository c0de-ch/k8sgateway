// Package orders is the in-memory demo data behind /api/orders. Nothing here
// knows about tokens: ownership is whatever the handler passes in.
package orders

import (
	"fmt"
	"sync"
	"time"
)

// Order is the JSON shape returned by the API.
type Order struct {
	ID        string    `json:"id"`
	Item      string    `json:"item"`
	Quantity  int       `json:"quantity"`
	Owner     string    `json:"owner"` // preferred_username (or sub) of the creator
	CreatedAt time.Time `json:"createdAt"`
}

// Store is a concurrency-safe in-memory order list.
type Store struct {
	mu     sync.RWMutex
	next   int
	orders []Order
}

// NewSeeded returns a store with three demo orders owned by alice and bob.
func NewSeeded() *Store {
	s := &Store{}
	now := time.Now().UTC()
	s.add("Mechanical keyboard", 1, "alice", now.Add(-3*time.Hour))
	s.add("USB-C cable", 3, "bob", now.Add(-2*time.Hour))
	s.add("27-inch monitor", 2, "alice", now.Add(-1*time.Hour))
	return s
}

func (s *Store) add(item string, quantity int, owner string, at time.Time) Order {
	s.next++
	o := Order{ID: fmt.Sprintf("ord-%d", s.next), Item: item, Quantity: quantity, Owner: owner, CreatedAt: at}
	s.orders = append(s.orders, o)
	return o
}

// Create appends a new order and returns it.
func (s *Store) Create(item string, quantity int, owner string) Order {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.add(item, quantity, owner, time.Now().UTC())
}

// All returns every order (admin view).
func (s *Store) All() []Order {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return append([]Order{}, s.orders...)
}

// ByOwner returns the orders created by one user. Always non-nil so the JSON is [] not null.
func (s *Store) ByOwner(owner string) []Order {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []Order{}
	for _, o := range s.orders {
		if o.Owner == owner {
			out = append(out, o)
		}
	}
	return out
}

// Stats returns the order count and the number of distinct owners.
func (s *Store) Stats() (orders, users int) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	owners := map[string]struct{}{}
	for _, o := range s.orders {
		owners[o.Owner] = struct{}{}
	}
	return len(s.orders), len(owners)
}
