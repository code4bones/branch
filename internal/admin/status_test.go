package admin

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/code4bones/branch/internal/observability"
	protocol "github.com/code4bones/branch/protocol/v0"
)

type staticProvider struct {
	snapshot StatusSnapshot
}

func (provider staticProvider) Snapshot() StatusSnapshot {
	return provider.snapshot
}

type staticDiagnosticsProvider struct {
	snapshot observability.Snapshot
}

func (provider staticDiagnosticsProvider) DiagnosticsSnapshot() observability.Snapshot {
	return provider.snapshot
}

type staticMetricsProvider struct {
	snapshot []observability.MetricSeries
}

func (provider staticMetricsProvider) MetricsSnapshot() []observability.MetricSeries {
	return provider.snapshot
}

type staticBootstrapProvider struct {
	response BootstrapBeaconResponse
	err      error
	request  BootstrapBeaconRequest
}

func (provider *staticBootstrapProvider) BootstrapBeacon(request BootstrapBeaconRequest) (BootstrapBeaconResponse, error) {
	provider.request = request
	return provider.response, provider.err
}

func TestReadinessDoesNotExposePeerOrTopologyFields(t *testing.T) {
	handler := NewHandler(staticProvider{snapshot: StatusSnapshot{
		ServiceName:       "branch-node",
		ServiceVersion:    "0.0.0",
		Readiness:         ReadinessReady,
		ProtocolVersions:  []string{"branch/connectivity/0"},
		Capabilities:      []string{"forward"},
		SessionsActive:    2,
		QueueDepth:        1,
		ExporterAvailable: false,
	}})

	response := handler.Readiness()

	if response.StatusCode != StatusOK {
		t.Fatalf("status = %d", response.StatusCode)
	}
	body := string(response.Body)
	for _, forbidden := range []string{"peer", "topology", "address", "identity", "session_id"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("readiness exposed forbidden field %q in %s", forbidden, body)
		}
	}

	var decoded StatusSnapshot
	if err := json.Unmarshal(response.Body, &decoded); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if decoded.Readiness != ReadinessReady {
		t.Fatalf("readiness = %q", decoded.Readiness)
	}
}

func TestReadinessReturnsUnavailableWhenNotReady(t *testing.T) {
	handler := NewHandler(staticProvider{snapshot: StatusSnapshot{Readiness: ReadinessNotReady}})

	response := handler.Readiness()

	if response.StatusCode != StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", response.StatusCode, StatusServiceUnavailable)
	}
}

func TestLivenessIsMinimal(t *testing.T) {
	handler := NewHandler(staticProvider{})

	response := handler.Liveness()

	if response.StatusCode != StatusOK {
		t.Fatalf("status = %d", response.StatusCode)
	}
	if got := string(response.Body); !strings.Contains(got, "alive") {
		t.Fatalf("unexpected liveness body %s", got)
	}
}

func TestDiagnosticsReturnsBoundedOperatorSnapshot(t *testing.T) {
	handler := NewHandler(
		staticProvider{},
		WithDiagnosticsProvider(staticDiagnosticsProvider{snapshot: observability.Snapshot{
			GeneratedAt: time.Date(2026, 8, 31, 12, 0, 0, 0, time.UTC),
			TotalEvents: 2,
			RecentLimit: 8,
			RecentEvents: []observability.EventSummary{{
				Event:           observability.EventRouteSelected,
				Level:           observability.LevelInfo,
				ProtocolVersion: "branch/connectivity/0",
			}},
		}}),
	)

	response := handler.Diagnostics()
	if response.StatusCode != StatusOK {
		t.Fatalf("status = %d", response.StatusCode)
	}

	body := string(response.Body)
	for _, forbidden := range []string{"trace", "span", "session_ref", "service_instance", "identity"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("diagnostics exposed forbidden field %q in %s", forbidden, body)
		}
	}
	if !strings.Contains(body, "route.selected") {
		t.Fatalf("diagnostics body missing event name: %s", body)
	}
}

func TestDiagnosticsUnavailableWithoutProvider(t *testing.T) {
	handler := NewHandler(staticProvider{})

	response := handler.Diagnostics()

	if response.StatusCode != StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", response.StatusCode, StatusServiceUnavailable)
	}
}

func TestMetricsReturnsInternalJSON(t *testing.T) {
	handler := NewHandler(
		staticProvider{},
		WithMetricsProvider(staticMetricsProvider{snapshot: []observability.MetricSeries{{
			Name:  observability.MetricSessionsActive,
			Value: 2,
			Labels: map[observability.MetricLabel]string{
				observability.MetricLabelCapability: "forward",
			},
		}}}),
	)

	response := handler.Metrics()

	if response.StatusCode != StatusOK {
		t.Fatalf("status = %d", response.StatusCode)
	}
	if !strings.Contains(string(response.Body), `"name":"branch_sessions_active"`) {
		t.Fatalf("unexpected metrics body: %s", response.Body)
	}
	if !strings.Contains(string(response.Body), `"value":2`) {
		t.Fatalf("unexpected metrics body: %s", response.Body)
	}
}

func TestBootstrapBeaconReturnsProtectedRelayOwnedWrapper(t *testing.T) {
	provider := &staticBootstrapProvider{response: BootstrapBeaconResponse{
		Wrapper:          "BRANCH0.example",
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
	handler := NewHandler(staticProvider{}, WithBootstrapBeaconProvider(provider))

	response := handler.BootstrapBeacon(BootstrapBeaconRequest{RelayEndpoints: []protocol.BootstrapRelayEndpoint{{
		Transport: "wss",
		URI:       "wss://branch.undoo.ru:443/relay/v0",
		Priority:  0,
	}}})

	if response.StatusCode != StatusOK {
		t.Fatalf("status = %d", response.StatusCode)
	}
	if !strings.Contains(string(response.Body), "BRANCH0.example") {
		t.Fatalf("missing wrapper: %s", response.Body)
	}
	if provider.request.RelayEndpoints[0].URI != "wss://branch.undoo.ru:443/relay/v0" {
		t.Fatalf("provider request = %+v", provider.request)
	}
}

func TestBootstrapBeaconUnavailableWithoutProvider(t *testing.T) {
	handler := NewHandler(staticProvider{})

	response := handler.BootstrapBeacon(BootstrapBeaconRequest{})

	if response.StatusCode != StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", response.StatusCode, StatusServiceUnavailable)
	}
}
