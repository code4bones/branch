package admin

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/code4bones/branch/internal/observability"
)

func TestHTTPHandlerRejectsRequestsWithoutAuthorizer(t *testing.T) {
	handler := NewHTTPHandler(NewHandler(staticProvider{}), nil)
	request := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusForbidden)
	}
}

func TestHTTPHandlerServesReadinessThroughAuthorizer(t *testing.T) {
	handler := NewHTTPHandler(
		NewHandler(staticProvider{snapshot: StatusSnapshot{Readiness: ReadinessReady}}),
		AuthorizerFunc(func(*http.Request) bool { return true }),
	)
	request := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	if got := response.Header().Get("cache-control"); got != "no-store" {
		t.Fatalf("cache-control = %q", got)
	}
	if !strings.Contains(response.Body.String(), "ready") {
		t.Fatalf("body missing readiness: %s", response.Body.String())
	}
}

func TestHTTPHandlerServesDiagnosticsWithoutCorrelationFields(t *testing.T) {
	handler := NewHTTPHandler(
		NewHandler(
			staticProvider{},
			WithDiagnosticsProvider(staticDiagnosticsProvider{snapshot: observability.Snapshot{
				GeneratedAt: time.Date(2026, 8, 31, 12, 0, 0, 0, time.UTC),
				TotalEvents: 1,
				RecentEvents: []observability.EventSummary{{
					Event: observability.EventQueueOverflow,
					Level: observability.LevelWarn,
				}},
			}}),
		),
		AuthorizerFunc(func(*http.Request) bool { return true }),
	)
	request := httptest.NewRequest(http.MethodGet, "/diagnostics", nil)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	body := response.Body.String()
	if !strings.Contains(body, "queue.overflow") {
		t.Fatalf("body missing diagnostic event: %s", body)
	}
	for _, forbidden := range []string{"trace", "span", "session_ref", "service_instance", "identity"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("diagnostics exposed forbidden field %q in %s", forbidden, body)
		}
	}
}

func TestHTTPHandlerAllowsOnlyGet(t *testing.T) {
	handler := NewHTTPHandler(NewHandler(staticProvider{}), AuthorizerFunc(func(*http.Request) bool { return true }))
	request := httptest.NewRequest(http.MethodPost, "/readyz", nil)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusMethodNotAllowed)
	}
}
