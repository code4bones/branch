package node

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/code4bones/branch/internal/admin"
)

func TestRelayMonitorReporterDisabledWhenUnconfigured(t *testing.T) {
	reporter, err := newRelayMonitorReporter(RelayMonitorConfig{}, staticNodeStatusProvider{})
	if err != nil {
		t.Fatalf("reporter error = %v", err)
	}
	if reporter != nil {
		t.Fatal("expected nil reporter")
	}
}

func TestRelayMonitorReporterRejectsPartialConfig(t *testing.T) {
	_, err := newRelayMonitorReporter(RelayMonitorConfig{RelayID: "relay01"}, staticNodeStatusProvider{})
	if err == nil {
		t.Fatal("expected partial config error")
	}
}

func TestRelayMonitorReporterPostsBoundedSnapshot(t *testing.T) {
	requests := make(chan admin.RelayMonitorReport, 1)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if got := request.Header.Get("authorization"); got != "Bearer monitor-token" {
			t.Fatalf("authorization = %q", got)
		}
		var report admin.RelayMonitorReport
		if err := json.NewDecoder(request.Body).Decode(&report); err != nil {
			t.Fatalf("decode report: %v", err)
		}
		requests <- report
		response.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	reporter, err := newRelayMonitorReporter(RelayMonitorConfig{
		RelayID:        "relay01",
		PublicEndpoint: "wss://relay01.undoo.ru:443/relay/v0",
		MasterURL:      server.URL,
		PushToken:      "monitor-token",
		Interval:       time.Second,
	}, staticNodeStatusProvider{snapshot: admin.StatusSnapshot{
		ServiceName:      "branch-node",
		ServiceVersion:   "0.0.0-test",
		Readiness:        admin.ReadinessReady,
		ProtocolVersions: []string{"branch/connectivity/0"},
		Capabilities:     []string{"relay.forward.live/0"},
		SessionsActive:   2,
		QueueDepth:       1,
	}})
	if err != nil {
		t.Fatalf("reporter error = %v", err)
	}

	reporter.reportOnce(t.Context())

	select {
	case report := <-requests:
		if report.RelayID != "relay01" || report.PublicEndpoint != "wss://relay01.undoo.ru:443/relay/v0" {
			t.Fatalf("unexpected report identity: %+v", report)
		}
		if report.Snapshot.SessionsActive != 2 || report.Snapshot.QueueDepth != 1 {
			t.Fatalf("unexpected counters: %+v", report.Snapshot)
		}
	case <-time.After(time.Second):
		t.Fatal("report not posted")
	}
}

func TestNewComposesRelayMonitorReporter(t *testing.T) {
	config := DefaultConfig()
	config.PublicAddr = "127.0.0.1:0"
	config.AdminAddr = "127.0.0.1:0"
	config.IdentityPath = filepath.Join(t.TempDir(), "node-identity.json")
	config.AdminToken = "admin-token"
	config.Monitor = RelayMonitorConfig{
		RelayID:        "relay01",
		PublicEndpoint: "wss://relay01.undoo.ru:443/relay/v0",
		MasterURL:      "https://branch.undoo.ru/node-admin/relay-monitor/reports",
		PushToken:      "monitor-token",
	}

	app, err := New(config)
	if err != nil {
		t.Fatalf("new app: %v", err)
	}
	if app.monitor == nil {
		t.Fatal("expected monitor reporter")
	}
	if app.monitor.config.Interval != defaultRelayMonitorInterval {
		t.Fatalf("interval = %s, want %s", app.monitor.config.Interval, defaultRelayMonitorInterval)
	}
}

type staticNodeStatusProvider struct {
	snapshot admin.StatusSnapshot
}

func (provider staticNodeStatusProvider) Snapshot() admin.StatusSnapshot {
	return provider.snapshot
}
