package admin

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRelayMonitorRegistryListsFreshAndStaleObservations(t *testing.T) {
	now := time.Date(2026, 9, 2, 10, 0, 0, 0, time.UTC)
	registry := NewRelayMonitorRegistry(RelayMonitorConfig{
		TTL:        time.Minute,
		StaleAfter: 10 * time.Second,
		MaxEntries: 2,
	})

	if err := registry.Accept(validRelayMonitorReport(), now); err != nil {
		t.Fatalf("accept report: %v", err)
	}

	fresh := registry.List(now.Add(5 * time.Second))
	if len(fresh) != 1 {
		t.Fatalf("fresh observations = %d, want 1", len(fresh))
	}
	if fresh[0].Stale {
		t.Fatal("fresh observation marked stale")
	}
	if fresh[0].BootstrapBeacon == nil || fresh[0].BootstrapBeacon.Wrapper != "BRANCH0.relay01" {
		t.Fatalf("missing bootstrap beacon: %+v", fresh[0].BootstrapBeacon)
	}
	if len(fresh[0].Federation) != 1 || fresh[0].Federation[0].PeerEndpoint != "wss://relay02.undoo.ru:443/relay/v0" {
		t.Fatalf("missing federation link: %+v", fresh[0].Federation)
	}

	stale := registry.List(now.Add(11 * time.Second))
	if len(stale) != 1 {
		t.Fatalf("stale observations = %d, want 1", len(stale))
	}
	if !stale[0].Stale {
		t.Fatal("stale observation not marked stale")
	}

	expired := registry.List(now.Add(time.Minute))
	if len(expired) != 0 {
		t.Fatalf("expired observations = %d, want 0", len(expired))
	}
}

func TestRelayMonitorRegistryRejectsUnboundedReports(t *testing.T) {
	registry := NewRelayMonitorRegistry(RelayMonitorConfig{})
	report := validRelayMonitorReport()
	report.Snapshot.QueueDepth = -1

	err := registry.Accept(report, time.Now())
	if err != ErrRelayMonitorInvalidReport {
		t.Fatalf("error = %v, want %v", err, ErrRelayMonitorInvalidReport)
	}

	report = validRelayMonitorReport()
	report.Snapshot.Capabilities = make([]string, maxRelayMonitorItems+1)
	for index := range report.Snapshot.Capabilities {
		report.Snapshot.Capabilities[index] = "relay.forward.live/0"
	}
	err = registry.Accept(report, time.Now())
	if err != ErrRelayMonitorInvalidReport {
		t.Fatalf("error = %v, want %v", err, ErrRelayMonitorInvalidReport)
	}

	report = validRelayMonitorReport()
	report.BootstrapBeacon = &RelayMonitorBootstrapBeacon{
		Wrapper:   "BRANCH0.not valid",
		ExpiresAt: 1800000000,
	}
	err = registry.Accept(report, time.Now())
	if err != ErrRelayMonitorInvalidReport {
		t.Fatalf("error = %v, want %v", err, ErrRelayMonitorInvalidReport)
	}

	report = validRelayMonitorReport()
	report.Federation = []RelayMonitorFederationLink{{
		PeerEndpoint: "wss://relay02.undoo.ru:443/relay/v0",
		State:        "plaintext_payload_dump",
	}}
	err = registry.Accept(report, time.Now())
	if err != ErrRelayMonitorInvalidReport {
		t.Fatalf("error = %v, want %v", err, ErrRelayMonitorInvalidReport)
	}
}

func TestRelayMonitorHTTPIngestRequiresDedicatedToken(t *testing.T) {
	registry := NewRelayMonitorRegistry(RelayMonitorConfig{})
	handler := NewHTTPHandler(
		NewHandler(staticProvider{}, WithRelayMonitorRegistry(registry)),
		AuthorizerFunc(func(request *http.Request) bool {
			return request.Header.Get("authorization") == "Bearer admin-token"
		}),
		WithRelayMonitorAuthorizer(AuthorizerFunc(func(request *http.Request) bool {
			return request.Header.Get("authorization") == "Bearer monitor-token"
		})),
	)
	body := encodeRelayMonitorReport(t, validRelayMonitorReport())
	request := httptest.NewRequest(http.MethodPost, RelayMonitorReportsPath, bytes.NewReader(body))
	request.Header.Set("authorization", "Bearer admin-token")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusForbidden)
	}
	if got := registry.List(time.Now()); len(got) != 0 {
		t.Fatalf("stored unauthorized observations: %+v", got)
	}
}

func TestRelayMonitorHTTPIngestAndList(t *testing.T) {
	now := time.Date(2026, 9, 2, 10, 0, 0, 0, time.UTC)
	registry := NewRelayMonitorRegistry(RelayMonitorConfig{})
	handler := NewHTTPHandler(
		NewHandler(staticProvider{}, WithRelayMonitorRegistry(registry)),
		AuthorizerFunc(func(request *http.Request) bool {
			return request.Header.Get("authorization") == "Bearer admin-token"
		}),
		WithRelayMonitorAuthorizer(AuthorizerFunc(func(request *http.Request) bool {
			return request.Header.Get("authorization") == "Bearer monitor-token"
		})),
		WithClock(func() time.Time { return now }),
	)
	report := validRelayMonitorReport()
	body := encodeRelayMonitorReport(t, report)
	request := httptest.NewRequest(http.MethodPost, RelayMonitorReportsPath, bytes.NewReader(body))
	request.Header.Set("authorization", "Bearer monitor-token")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("post status = %d, body = %s", response.Code, response.Body.String())
	}

	listRequest := httptest.NewRequest(http.MethodGet, RelayMonitorReportsPath, nil)
	listRequest.Header.Set("authorization", "Bearer admin-token")
	listResponse := httptest.NewRecorder()
	handler.ServeHTTP(listResponse, listRequest)

	if listResponse.Code != http.StatusOK {
		t.Fatalf("list status = %d", listResponse.Code)
	}
	bodyText := listResponse.Body.String()
	if !strings.Contains(bodyText, `"relay_id":"relay01"`) {
		t.Fatalf("missing relay report: %s", bodyText)
	}
	if !strings.Contains(bodyText, `"bootstrap_beacon"`) || !strings.Contains(bodyText, `"wrapper":"BRANCH0.relay01"`) {
		t.Fatalf("missing relay bootstrap beacon: %s", bodyText)
	}
	for _, forbidden := range []string{"monitor-token", "admin-token", "payload", "public_key", "cookie"} {
		if strings.Contains(bodyText, forbidden) {
			t.Fatalf("relay monitor list leaked %q in %s", forbidden, bodyText)
		}
	}
}

func TestRelayMonitorHTTPRejectsUnknownJSONFields(t *testing.T) {
	handler := NewHTTPHandler(
		NewHandler(staticProvider{}, WithRelayMonitorRegistry(NewRelayMonitorRegistry(RelayMonitorConfig{}))),
		AuthorizerFunc(func(*http.Request) bool { return true }),
		WithRelayMonitorAuthorizer(AuthorizerFunc(func(*http.Request) bool { return true })),
	)
	body := []byte(`{"relay_id":"relay01","public_endpoint":"wss://relay01.undoo.ru:443/relay/v0","snapshot":{"service_name":"branch-node","service_version":"0.0.0","readiness":"ready","protocol_versions":["branch/connectivity/0"],"capabilities":["relay.forward.live/0"]},"secret":"nope"}`)
	request := httptest.NewRequest(http.MethodPost, RelayMonitorReportsPath, bytes.NewReader(body))
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusBadRequest)
	}
}

func validRelayMonitorReport() RelayMonitorReport {
	return RelayMonitorReport{
		RelayID:        "relay01",
		PublicEndpoint: "wss://relay01.undoo.ru:443/relay/v0",
		ReportedAt:     time.Date(2026, 9, 2, 10, 0, 0, 0, time.UTC),
		BootstrapBeacon: &RelayMonitorBootstrapBeacon{
			Wrapper:   "BRANCH0.relay01",
			ExpiresAt: 1800000000,
		},
		Federation: []RelayMonitorFederationLink{{
			PeerEndpoint: "wss://relay02.undoo.ru:443/relay/v0",
			State:        "configured",
			LastReason:   "not_probed",
			LookupCount:  0,
			BridgeCount:  0,
		}},
		Snapshot: StatusSnapshot{
			ServiceName:      "branch-node",
			ServiceVersion:   "0.0.0-test",
			Readiness:        ReadinessReady,
			ProtocolVersions: []string{"branch/connectivity/0"},
			Capabilities:     []string{"relay.forward.live/0"},
			SessionsActive:   1,
			RoutesActive:     1,
			PresenceActive:   1,
			QueueDepth:       0,
		},
	}
}

func encodeRelayMonitorReport(t *testing.T, report RelayMonitorReport) []byte {
	t.Helper()
	body, err := json.Marshal(report)
	if err != nil {
		t.Fatalf("encode report: %v", err)
	}
	return body
}
