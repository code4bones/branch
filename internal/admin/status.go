package admin

import (
	"encoding/json"
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

type Handler struct {
	provider SnapshotProvider
}

func NewHandler(provider SnapshotProvider) *Handler {
	return &Handler{provider: provider}
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
