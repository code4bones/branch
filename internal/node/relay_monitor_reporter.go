package node

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"time"

	"github.com/code4bones/branch/internal/admin"
	protocol "github.com/code4bones/branch/protocol/v0"
)

const (
	defaultRelayMonitorInterval = 30 * time.Second
	minRelayMonitorInterval     = 5 * time.Second
	relayMonitorPostTimeout     = 3 * time.Second
)

// RelayMonitorConfig configures optional beta relay-to-master status reporting.
type RelayMonitorConfig struct {
	RelayID        string
	PublicEndpoint string
	MasterURL      string
	PushToken      string
	Interval       time.Duration
}

type relayMonitorReporter struct {
	config              RelayMonitorConfig
	provider            admin.SnapshotProvider
	bootstrapProvider   admin.BootstrapBeaconProvider
	federationProvider  relayMonitorFederationProvider
	diagnosticsProvider admin.DiagnosticsSnapshotProvider
	client              *http.Client
}

type relayMonitorFederationProvider interface {
	FederationLinks() []admin.RelayMonitorFederationLink
	FederationCarrier() *admin.RelayMonitorFederationCarrier
}

func newRelayMonitorReporter(config RelayMonitorConfig, provider admin.SnapshotProvider, bootstrapProvider admin.BootstrapBeaconProvider, federationProvider relayMonitorFederationProvider, diagnosticsProvider admin.DiagnosticsSnapshotProvider) (*relayMonitorReporter, error) {
	if !config.enabled() {
		return nil, nil
	}
	if provider == nil {
		return nil, fmt.Errorf("%w: relay monitor provider is nil", ErrInvalidConfig)
	}
	if config.RelayID == "" || config.PublicEndpoint == "" || config.MasterURL == "" || config.PushToken == "" {
		return nil, fmt.Errorf("%w: incomplete relay monitor config", ErrInvalidConfig)
	}
	parsedMasterURL, err := url.ParseRequestURI(config.MasterURL)
	if err != nil || (parsedMasterURL.Scheme != "http" && parsedMasterURL.Scheme != "https") || parsedMasterURL.Host == "" {
		return nil, fmt.Errorf("%w: invalid relay monitor master url", ErrInvalidConfig)
	}
	if config.Interval <= 0 {
		config.Interval = defaultRelayMonitorInterval
	}
	if config.Interval < minRelayMonitorInterval {
		config.Interval = minRelayMonitorInterval
	}
	return &relayMonitorReporter{
		config:              config,
		provider:            provider,
		bootstrapProvider:   bootstrapProvider,
		federationProvider:  federationProvider,
		diagnosticsProvider: diagnosticsProvider,
		client: &http.Client{
			Timeout: relayMonitorPostTimeout,
		},
	}, nil
}

func (config RelayMonitorConfig) enabled() bool {
	return config.RelayID != "" || config.PublicEndpoint != "" || config.MasterURL != "" || config.PushToken != ""
}

func (reporter *relayMonitorReporter) run(ctx context.Context) {
	reporter.reportOnce(ctx)
	ticker := time.NewTicker(reporter.config.Interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			reporter.reportOnce(ctx)
		}
	}
}

func (reporter *relayMonitorReporter) reportOnce(ctx context.Context) {
	requestCtx, cancel := context.WithTimeout(ctx, relayMonitorPostTimeout)
	defer cancel()

	report := admin.RelayMonitorReport{
		RelayID:           reporter.config.RelayID,
		PublicEndpoint:    reporter.config.PublicEndpoint,
		ReportedAt:        time.Now().UTC(),
		Snapshot:          reporter.provider.Snapshot(),
		BootstrapBeacon:   reporter.bootstrapBeacon(),
		Federation:        reporter.federationLinks(),
		FederationCarrier: reporter.federationCarrier(),
		Diagnostics:       reporter.diagnostics(),
	}
	body, err := json.Marshal(report)
	if err != nil {
		slog.Warn("relay.monitor.report.failed", "reason", "encode_failed")
		return
	}
	request, err := http.NewRequestWithContext(requestCtx, http.MethodPost, reporter.config.MasterURL, bytes.NewReader(body))
	if err != nil {
		slog.Warn("relay.monitor.report.failed", "reason", "request_failed")
		return
	}
	request.Header.Set("authorization", "Bearer "+reporter.config.PushToken)
	request.Header.Set("content-type", "application/json")

	response, err := reporter.client.Do(request)
	if err != nil {
		slog.Warn("relay.monitor.report.failed", "reason", "post_failed")
		return
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1024))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		slog.Warn("relay.monitor.report.failed", "reason", "unexpected_status", "status", response.StatusCode)
	}
}

func (reporter *relayMonitorReporter) diagnostics() *admin.RelayMonitorDiagnostics {
	if reporter.diagnosticsProvider == nil {
		return nil
	}
	snapshot := reporter.diagnosticsProvider.DiagnosticsSnapshot()
	start := len(snapshot.RecentEvents) - 16
	if start < 0 {
		start = 0
	}
	events := make([]admin.RelayMonitorDiagnosticEvent, 0, len(snapshot.RecentEvents)-start)
	for _, event := range snapshot.RecentEvents[start:] {
		events = append(events, admin.RelayMonitorDiagnosticEvent{
			Timestamp:      event.Timestamp.UTC(),
			DurationMillis: event.DurationMillis,
			Event:          event.Event,
			Level:          event.Level,
			ReasonCode:     event.ReasonCode,
		})
	}
	return &admin.RelayMonitorDiagnostics{
		TotalEvents:   snapshot.TotalEvents,
		DroppedEvents: snapshot.DroppedEvents,
		RecentEvents:  events,
	}
}

func (reporter *relayMonitorReporter) federationLinks() []admin.RelayMonitorFederationLink {
	if reporter.federationProvider == nil {
		return nil
	}
	return reporter.federationProvider.FederationLinks()
}

func (reporter *relayMonitorReporter) federationCarrier() *admin.RelayMonitorFederationCarrier {
	if reporter.federationProvider == nil {
		return nil
	}
	return reporter.federationProvider.FederationCarrier()
}

func (reporter *relayMonitorReporter) bootstrapBeacon() *admin.RelayMonitorBootstrapBeacon {
	if reporter.bootstrapProvider == nil {
		return nil
	}
	response, err := reporter.bootstrapProvider.BootstrapBeacon(admin.BootstrapBeaconRequest{
		RelayEndpoints: []protocol.BootstrapRelayEndpoint{{
			Transport: "wss",
			URI:       reporter.config.PublicEndpoint,
			Priority:  0,
		}},
	})
	if err != nil {
		slog.Warn("relay.monitor.bootstrap_beacon.failed", "reason", "generate_failed")
		return nil
	}
	return &admin.RelayMonitorBootstrapBeacon{
		Wrapper:   response.Wrapper,
		ExpiresAt: response.ExpiresAt,
	}
}
