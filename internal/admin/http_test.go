package admin

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/code4bones/branch/internal/observability"
	protocol "github.com/code4bones/branch/protocol/v0"
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

func TestHTTPHandlerServesMetricsAsJSON(t *testing.T) {
	handler := NewHTTPHandler(
		NewHandler(
			staticProvider{},
			WithMetricsProvider(staticMetricsProvider{snapshot: []observability.MetricSeries{{
				Name:  observability.MetricQueueDepth,
				Value: 3,
			}}}),
		),
		AuthorizerFunc(func(*http.Request) bool { return true }),
	)
	request := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	if got := response.Header().Get("content-type"); got != "application/json" {
		t.Fatalf("content-type = %q", got)
	}
	if !strings.Contains(response.Body.String(), `"name":"branch_queue_depth"`) {
		t.Fatalf("metrics body = %s", response.Body.String())
	}
}

func TestHTTPHandlerServesUnavailableMetricsAsJSON(t *testing.T) {
	handler := NewHTTPHandler(
		NewHandler(staticProvider{}),
		AuthorizerFunc(func(*http.Request) bool { return true }),
	)
	request := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", response.Code, StatusServiceUnavailable)
	}
	if got := response.Header().Get("content-type"); got != "application/json" {
		t.Fatalf("content-type = %q", got)
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

func TestHTTPHandlerServesAuthorizedBootstrapBeacon(t *testing.T) {
	bootstrapProvider := &staticBootstrapProvider{response: BootstrapBeaconResponse{
		Wrapper:          "BRANCH0.http",
		RelayPublicKey:   "relay-key",
		Protocol:         protocol.ProtocolID,
		ProfileMultihash: protocol.DevelopmentProfileMultihash,
		ExpiresAt:        1_789_000_000,
		RelayEndpoints: []protocol.BootstrapRelayEndpoint{{
			Transport: "wss",
			URI:       "wss://branch.undoo.ru:443/relay/v0",
			Priority:  0,
		}},
	}}
	handler := NewHTTPHandler(
		NewHandler(staticProvider{}, WithBootstrapBeaconProvider(bootstrapProvider)),
		AuthorizerFunc(func(request *http.Request) bool {
			return request.Header.Get("authorization") == "Bearer token"
		}),
	)
	request := httptest.NewRequest(http.MethodGet, "/bootstrap/beacon?endpoint=wss%3A%2F%2Fbranch.undoo.ru%3A443%2Frelay%2Fv0", nil)
	request.Header.Set("authorization", "Bearer token")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	if !strings.Contains(response.Body.String(), "BRANCH0.http") {
		t.Fatalf("body missing wrapper: %s", response.Body.String())
	}
	if bootstrapProvider.request.RelayEndpoints[0].URI != "wss://branch.undoo.ru:443/relay/v0" {
		t.Fatalf("bootstrap request = %+v", bootstrapProvider.request)
	}
}

func TestHTTPHandlerRejectsBootstrapBeaconWithoutEndpoint(t *testing.T) {
	handler := NewHTTPHandler(
		NewHandler(staticProvider{}, WithBootstrapBeaconProvider(&staticBootstrapProvider{})),
		AuthorizerFunc(func(*http.Request) bool { return true }),
	)
	request := httptest.NewRequest(http.MethodGet, "/bootstrap/beacon", nil)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusBadRequest)
	}
}
