package admin

import (
	"encoding/json"

	"github.com/code4bones/branch/internal/observability"
)

const (
	StatusOK                 = 200
	StatusServiceUnavailable = 503
)

type ReadinessState string

const (
	ReadinessReady    ReadinessState = "ready"
	ReadinessDegraded ReadinessState = "degraded"
	ReadinessNotReady ReadinessState = "not_ready"
)

type StatusSnapshot struct {
	ServiceName       string         `json:"service_name"`
	ServiceVersion    string         `json:"service_version"`
	Readiness         ReadinessState `json:"readiness"`
	ProtocolVersions  []string       `json:"protocol_versions"`
	Capabilities      []string       `json:"capabilities"`
	SessionsActive    int            `json:"sessions_active"`
	RoutesActive      int            `json:"routes_active"`
	PresenceActive    int            `json:"presence_active"`
	QueueDepth        int            `json:"queue_depth"`
	ExporterAvailable bool           `json:"exporter_available"`
}

type Response struct {
	StatusCode int
	Body       []byte
}

type SnapshotProvider interface {
	Snapshot() StatusSnapshot
}

// DiagnosticsSnapshotProvider supplies the protected diagnostic admin view.
type DiagnosticsSnapshotProvider interface {
	DiagnosticsSnapshot() observability.Snapshot
}

// MetricsProvider supplies protected bounded-cardinality metrics.
type MetricsProvider interface {
	MetricsSnapshot() []observability.MetricSeries
}

type Handler struct {
	provider            SnapshotProvider
	diagnosticsProvider DiagnosticsSnapshotProvider
	metricsProvider     MetricsProvider
}

// HandlerOption configures optional protected admin surfaces.
type HandlerOption func(*Handler)

// WithDiagnosticsProvider attaches the protected diagnostic snapshot surface.
func WithDiagnosticsProvider(provider DiagnosticsSnapshotProvider) HandlerOption {
	return func(handler *Handler) {
		handler.diagnosticsProvider = provider
	}
}

// WithMetricsProvider attaches the protected metrics surface.
func WithMetricsProvider(provider MetricsProvider) HandlerOption {
	return func(handler *Handler) {
		handler.metricsProvider = provider
	}
}

// NewHandler creates an admin handler over protected operator snapshots.
func NewHandler(provider SnapshotProvider, options ...HandlerOption) *Handler {
	handler := &Handler{provider: provider}
	for _, option := range options {
		option(handler)
	}
	return handler
}

func (handler *Handler) Liveness() Response {
	return jsonResponse(StatusOK, map[string]string{"status": "alive"})
}

func (handler *Handler) Readiness() Response {
	snapshot := handler.provider.Snapshot()
	status := StatusOK
	if snapshot.Readiness == ReadinessNotReady {
		status = StatusServiceUnavailable
	}
	return jsonResponse(status, sanitizeSnapshot(snapshot))
}

// Diagnostics returns the bounded operator diagnostic snapshot.
func (handler *Handler) Diagnostics() Response {
	if handler.diagnosticsProvider == nil {
		return jsonResponse(StatusServiceUnavailable, map[string]string{"status": "unavailable"})
	}
	return jsonResponse(StatusOK, handler.diagnosticsProvider.DiagnosticsSnapshot())
}

// Metrics returns bounded-cardinality metrics for the observation front.
func (handler *Handler) Metrics() Response {
	if handler.metricsProvider == nil {
		return jsonResponse(StatusServiceUnavailable, map[string]string{"status": "unavailable"})
	}
	return jsonResponse(StatusOK, handler.metricsProvider.MetricsSnapshot())
}

func sanitizeSnapshot(snapshot StatusSnapshot) StatusSnapshot {
	if snapshot.ProtocolVersions == nil {
		snapshot.ProtocolVersions = []string{}
	}
	if snapshot.Capabilities == nil {
		snapshot.Capabilities = []string{}
	}
	return snapshot
}

func jsonResponse(status int, value any) Response {
	data, err := json.Marshal(value)
	if err != nil {
		return Response{StatusCode: StatusServiceUnavailable, Body: []byte(`{"status":"unavailable"}`)}
	}
	return Response{StatusCode: status, Body: append(data, '\n')}
}
