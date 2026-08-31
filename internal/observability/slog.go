package observability

import (
	"context"
	"log/slog"
	"sort"
)

// SlogSink emits validated envelopes as structured slog records.
type SlogSink struct {
	logger *slog.Logger
	mode   Mode
}

// NewSlogSink creates a structured log sink for operator or development modes.
func NewSlogSink(logger *slog.Logger, mode Mode) *SlogSink {
	if logger == nil {
		logger = slog.Default()
	}
	return &SlogSink{logger: logger, mode: mode}
}

// Emit writes one structured event unless observability mode is off.
func (sink *SlogSink) Emit(ctx context.Context, envelope Envelope) error {
	if sink.mode == ModeOff || ctx.Err() != nil {
		return nil
	}
	if err := envelope.Validate(); err != nil {
		return err
	}

	attrs := []slog.Attr{
		slog.Time("timestamp", envelope.Timestamp.UTC()),
		slog.String("event", string(envelope.Event)),
		slog.String("level", string(envelope.Level)),
	}
	appendStringAttr := func(key, value string) {
		if value != "" {
			attrs = append(attrs, slog.String(key, sanitizeValue(value)))
		}
	}
	appendStringAttr("service_name", envelope.ServiceName)
	appendStringAttr("service_version", envelope.ServiceVersion)
	appendStringAttr("deployment_environment", envelope.DeploymentEnvironment)
	appendStringAttr("node_role", envelope.NodeRole)
	appendStringAttr("protocol_version", envelope.ProtocolVersion)
	if envelope.ReasonCode != "" {
		appendStringAttr("reason_code", string(envelope.ReasonCode))
	}
	for _, attribute := range sortedAttributes(envelope.Attributes) {
		appendStringAttr("attribute_"+string(attribute.Key), attribute.Value)
	}

	sink.logger.LogAttrs(ctx, slogLevel(envelope.Level), string(envelope.Event), attrs...)
	return nil
}

func slogLevel(level Level) slog.Level {
	switch level {
	case LevelDebug:
		return slog.LevelDebug
	case LevelInfo:
		return slog.LevelInfo
	case LevelWarn:
		return slog.LevelWarn
	case LevelError:
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

func sortedAttributes(attributes map[AttributeKey]string) []Attribute {
	keys := make([]AttributeKey, 0, len(attributes))
	for key := range attributes {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(left, right int) bool {
		return keys[left] < keys[right]
	})

	result := make([]Attribute, 0, len(keys))
	for _, key := range keys {
		result = append(result, Attribute{Key: key, Value: attributes[key]})
	}
	return result
}
