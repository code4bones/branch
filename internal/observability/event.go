package observability

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	MaxAttributeValueBytes = 256
	MaxAttributes          = 16
)

var (
	ErrInvalidEvent     = errors.New("invalid observability event")
	ErrForbiddenField   = errors.New("forbidden observability field")
	ErrUnknownAttribute = errors.New("unknown observability attribute")
)

type Mode string

const (
	ModeOff         Mode = "off"
	ModeOperator    Mode = "operator"
	ModeDevelopment Mode = "development"
	ModeDiagnostic  Mode = "diagnostic"
)

type Level string

const (
	LevelDebug Level = "debug"
	LevelInfo  Level = "info"
	LevelWarn  Level = "warn"
	LevelError Level = "error"
)

type EventName string

const (
	EventProcessStarted            EventName = "process.started"
	EventProcessReady              EventName = "process.ready"
	EventProcessStopping           EventName = "process.stopping"
	EventProcessStopped            EventName = "process.stopped"
	EventConfigRejected            EventName = "config.rejected"
	EventCarrierSearchStarted      EventName = "carrier.search.started"
	EventCarrierSearchCompleted    EventName = "carrier.search.completed"
	EventCarrierSearchFailed       EventName = "carrier.search.failed"
	EventBeaconValidationAccepted  EventName = "beacon.validation.accepted"
	EventBeaconValidationRejected  EventName = "beacon.validation.rejected"
	EventConnectionAccepted        EventName = "connection.accepted"
	EventConnectionEstablished     EventName = "connection.established"
	EventConnectionClosed          EventName = "connection.closed"
	EventHandshakeStarted          EventName = "handshake.started"
	EventHandshakeCompleted        EventName = "handshake.completed"
	EventHandshakeFailed           EventName = "handshake.failed"
	EventRouteCandidateAccepted    EventName = "route.candidate.accepted"
	EventRouteCandidateRejected    EventName = "route.candidate.rejected"
	EventRouteSelected             EventName = "route.selected"
	EventRouteMigrationStarted     EventName = "route.migration.started"
	EventRouteMigrationCompleted   EventName = "route.migration.completed"
	EventRouteMigrationFailed      EventName = "route.migration.failed"
	EventRelayPeerConnected        EventName = "relay.peer.connected"
	EventRelayPeerDisconnected     EventName = "relay.peer.disconnected"
	EventRelayFrameRejected        EventName = "relay.frame.rejected"
	EventQueueHighWatermark        EventName = "queue.high_watermark"
	EventQueueOverflow             EventName = "queue.overflow"
	EventGossipRecordAccepted      EventName = "gossip.record.accepted"
	EventGossipRecordRejected      EventName = "gossip.record.rejected"
	EventGossipExchangeCompleted   EventName = "gossip.exchange.completed"
	EventRateLimitApplied          EventName = "rate_limit.applied"
	EventAdminAuthenticationFailed EventName = "admin.authentication.failed"
	EventAdminConfigurationChanged EventName = "admin.configuration.changed"
	EventDiagnosticExportCreated   EventName = "diagnostic.export.created"
	EventDiagnosticModeExpired     EventName = "diagnostic.mode.expired"
)

type ReasonCode string

const (
	ReasonConfigInvalid              ReasonCode = "config_invalid"
	ReasonCarrierUnavailable         ReasonCode = "carrier_unavailable"
	ReasonCarrierTimeout             ReasonCode = "carrier_timeout"
	ReasonBeaconExpired              ReasonCode = "beacon_expired"
	ReasonBeaconMalformed            ReasonCode = "beacon_malformed"
	ReasonBeaconSignatureInvalid     ReasonCode = "beacon_signature_invalid"
	ReasonProtocolVersionUnsupported ReasonCode = "protocol_version_unsupported"
	ReasonCapabilityUnsupported      ReasonCode = "capability_unsupported"
	ReasonPeerUnreachable            ReasonCode = "peer_unreachable"
	ReasonHandshakeTimeout           ReasonCode = "handshake_timeout"
	ReasonHandshakeProtocolError     ReasonCode = "handshake_protocol_error"
	ReasonRouteNoCandidate           ReasonCode = "route_no_candidate"
	ReasonRouteDegraded              ReasonCode = "route_degraded"
	ReasonRelayUnavailable           ReasonCode = "relay_unavailable"
	ReasonQueueHighWatermark         ReasonCode = "queue_high_watermark"
	ReasonQueueOverflow              ReasonCode = "queue_overflow"
	ReasonFrameOversized             ReasonCode = "frame_oversized"
	ReasonFrameMalformed             ReasonCode = "frame_malformed"
	ReasonFrameUnauthenticated       ReasonCode = "frame_unauthenticated"
	ReasonRateLimitExceeded          ReasonCode = "rate_limit_exceeded"
	ReasonExporterUnavailable        ReasonCode = "exporter_unavailable"
	ReasonDiagnosticExpired          ReasonCode = "diagnostic_expired"
)

type AttributeKey string

const (
	AttributeCapability      AttributeKey = "capability"
	AttributeCarrier         AttributeKey = "carrier"
	AttributeDirection       AttributeKey = "direction"
	AttributeProtocolVersion AttributeKey = "protocol_version"
	AttributeResult          AttributeKey = "result"
	AttributeTransport       AttributeKey = "transport"
)

type Attribute struct {
	Key   AttributeKey
	Value string
}

type Envelope struct {
	Timestamp             time.Time
	Event                 EventName
	Level                 Level
	ServiceName           string
	ServiceVersion        string
	ServiceInstanceID     string
	DeploymentEnvironment string
	NodeRole              string
	ProtocolVersion       string
	TraceID               string
	SpanID                string
	SessionRef            string
	ReasonCode            ReasonCode
	Attributes            map[AttributeKey]string
}

type Sink interface {
	Emit(ctx context.Context, event Envelope) error
}

type SinkFunc func(context.Context, Envelope) error

func (fn SinkFunc) Emit(ctx context.Context, event Envelope) error {
	return fn(ctx, event)
}

type NoopSink struct{}

func (NoopSink) Emit(context.Context, Envelope) error {
	return nil
}

func NewEnvelope(event EventName, level Level, options ...Option) (Envelope, error) {
	envelope := Envelope{
		Timestamp:  time.Now().UTC(),
		Event:      event,
		Level:      level,
		Attributes: make(map[AttributeKey]string),
	}

	for _, option := range options {
		if err := option(&envelope); err != nil {
			return Envelope{}, err
		}
	}

	if err := envelope.Validate(); err != nil {
		return Envelope{}, err
	}
	return envelope, nil
}

type Option func(*Envelope) error

func WithService(name, version, instanceID, environment, nodeRole string) Option {
	return func(envelope *Envelope) error {
		envelope.ServiceName = sanitizeValue(name)
		envelope.ServiceVersion = sanitizeValue(version)
		envelope.ServiceInstanceID = sanitizeValue(instanceID)
		envelope.DeploymentEnvironment = sanitizeValue(environment)
		envelope.NodeRole = sanitizeValue(nodeRole)
		return nil
	}
}

func WithProtocolVersion(protocolVersion string) Option {
	return func(envelope *Envelope) error {
		envelope.ProtocolVersion = sanitizeValue(protocolVersion)
		return nil
	}
}

func WithReason(reason ReasonCode) Option {
	return func(envelope *Envelope) error {
		if !KnownReason(reason) {
			return ErrInvalidEvent
		}
		envelope.ReasonCode = reason
		return nil
	}
}

func WithAttribute(attribute Attribute) Option {
	return func(envelope *Envelope) error {
		if len(envelope.Attributes) >= MaxAttributes {
			return ErrInvalidEvent
		}
		if !AllowedAttribute(attribute.Key) {
			return ErrUnknownAttribute
		}
		if forbiddenValue(attribute.Value) {
			return ErrForbiddenField
		}
		envelope.Attributes[attribute.Key] = sanitizeValue(attribute.Value)
		return nil
	}
}

func (envelope Envelope) Validate() error {
	if !KnownEvent(envelope.Event) {
		return ErrInvalidEvent
	}
	if !KnownLevel(envelope.Level) {
		return ErrInvalidEvent
	}
	if envelope.ReasonCode != "" && !KnownReason(envelope.ReasonCode) {
		return ErrInvalidEvent
	}
	for key, value := range envelope.Attributes {
		if !AllowedAttribute(key) {
			return ErrUnknownAttribute
		}
		if forbiddenValue(value) {
			return ErrForbiddenField
		}
	}
	return nil
}

func KnownEvent(event EventName) bool {
	switch event {
	case EventProcessStarted,
		EventProcessReady,
		EventProcessStopping,
		EventProcessStopped,
		EventConfigRejected,
		EventCarrierSearchStarted,
		EventCarrierSearchCompleted,
		EventCarrierSearchFailed,
		EventBeaconValidationAccepted,
		EventBeaconValidationRejected,
		EventConnectionAccepted,
		EventConnectionEstablished,
		EventConnectionClosed,
		EventHandshakeStarted,
		EventHandshakeCompleted,
		EventHandshakeFailed,
		EventRouteCandidateAccepted,
		EventRouteCandidateRejected,
		EventRouteSelected,
		EventRouteMigrationStarted,
		EventRouteMigrationCompleted,
		EventRouteMigrationFailed,
		EventRelayPeerConnected,
		EventRelayPeerDisconnected,
		EventRelayFrameRejected,
		EventQueueHighWatermark,
		EventQueueOverflow,
		EventGossipRecordAccepted,
		EventGossipRecordRejected,
		EventGossipExchangeCompleted,
		EventRateLimitApplied,
		EventAdminAuthenticationFailed,
		EventAdminConfigurationChanged,
		EventDiagnosticExportCreated,
		EventDiagnosticModeExpired:
		return true
	default:
		return false
	}
}

func KnownLevel(level Level) bool {
	switch level {
	case LevelDebug, LevelInfo, LevelWarn, LevelError:
		return true
	default:
		return false
	}
}

func KnownReason(reason ReasonCode) bool {
	switch reason {
	case ReasonConfigInvalid,
		ReasonCarrierUnavailable,
		ReasonCarrierTimeout,
		ReasonBeaconExpired,
		ReasonBeaconMalformed,
		ReasonBeaconSignatureInvalid,
		ReasonProtocolVersionUnsupported,
		ReasonCapabilityUnsupported,
		ReasonPeerUnreachable,
		ReasonHandshakeTimeout,
		ReasonHandshakeProtocolError,
		ReasonRouteNoCandidate,
		ReasonRouteDegraded,
		ReasonRelayUnavailable,
		ReasonQueueHighWatermark,
		ReasonQueueOverflow,
		ReasonFrameOversized,
		ReasonFrameMalformed,
		ReasonFrameUnauthenticated,
		ReasonRateLimitExceeded,
		ReasonExporterUnavailable,
		ReasonDiagnosticExpired:
		return true
	default:
		return false
	}
}

func AllowedAttribute(key AttributeKey) bool {
	switch key {
	case AttributeCapability,
		AttributeCarrier,
		AttributeDirection,
		AttributeProtocolVersion,
		AttributeResult,
		AttributeTransport:
		return true
	default:
		return false
	}
}

func sanitizeValue(value string) string {
	value = strings.TrimSpace(value)
	if len(value) <= MaxAttributeValueBytes {
		return value
	}
	limit := MaxAttributeValueBytes
	for limit > 0 && !utf8.ValidString(value[:limit]) {
		limit--
	}
	return value[:limit]
}

func forbiddenValue(value string) bool {
	value = strings.ToLower(value)
	forbidden := []string{
		"payload",
		"private_key",
		"capability_token",
		"identity_export",
		"authentication_secret",
	}
	for _, marker := range forbidden {
		if strings.Contains(value, marker) {
			return true
		}
	}
	return false
}
