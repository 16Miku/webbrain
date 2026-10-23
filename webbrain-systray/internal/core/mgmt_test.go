package core

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestModelsRejectsHTTPErrorResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"error":"temporarily unavailable"}`))
	}))
	defer server.Close()
	m := newMgmt(server.URL, "pass", "key")
	models, err := m.Models(context.Background())
	var apiErr *APIError
	if models != nil || !errors.As(err, &apiErr) || apiErr.Status != http.StatusServiceUnavailable {
		t.Fatalf("Models returned %v, %v; want HTTP 503 error", models, err)
	}
}
