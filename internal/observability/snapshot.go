package observability

import (
	"context"
	"sort"
	"sync"
	"time"
)

// DefaultRecentEventLimit bounds the in-memory operator diagnostic view.
const DefaultRecentEventLimit = 128

// Snapshot is the bounded operator-facing diagnostic view of recent events.
// It intentionally omits trace, span, session, service-instance, address, and
// peer identity fields.
type Snapshot struct {
	GeneratedAt   time.Time      `json:"generated_at"`
	TotalEvents   uint64         `json:"total_events"`
	DroppedEvents uint64         `json:"dropped_events"`
	RecentLimit   int            `json:"recent_limit"`
	RecentEvents  []EventSummary `json:"recent_events"`
	EventsByName  []EventCount   `json:"events_by_name"`
	Reasons       []ReasonCount  `json:"reasons"`
}

// EventSummary is a redacted recent-event projection for admin diagnostics.
type EventSummary struct {
	Timestamp       time.Time               `json:"timestamp"`
	DurationMillis  uint64                  `json:"duration_ms,omitempty"`
	Event           EventName               `json:"event"`
	Level           Level                   `json:"level"`
	ProtocolVersion string                  `json:"protocol_version,omitempty"`
	ReasonCode      ReasonCode              `json:"reason_code,omitempty"`
	Attributes      map[AttributeKey]string `json:"attributes,omitempty"`
}

// EventCount aggregates bounded taxonomy events by stable name.
type EventCount struct {
	Event EventName `json:"event"`
	Count uint64    `json:"count"`
}

// ReasonCount aggregates bounded failure reasons by stable reason code.
type ReasonCount struct {
	Reason ReasonCode `json:"reason"`
	Count  uint64     `json:"count"`
}

// RecorderOptions configures the bounded in-memory diagnostic recorder.
type RecorderOptions struct {
	RecentLimit int
	Now         func() time.Time
}

// Recorder stores a bounded in-memory diagnostic view for an operator admin
// surface. It is telemetry state only and is never used for delivery or replay.
type Recorder struct {
	mu            sync.Mutex
	recentLimit   int
	now           func() time.Time
	totalEvents   uint64
	droppedEvents uint64
	recentEvents  []EventSummary
	eventsByName  map[EventName]uint64
	reasons       map[ReasonCode]uint64
}

// NewRecorder creates an in-memory recorder with a bounded recent-event ring.
func NewRecorder(options RecorderOptions) *Recorder {
	limit := options.RecentLimit
	if limit <= 0 {
		limit = DefaultRecentEventLimit
	}
	now := options.Now
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}

	return &Recorder{
		recentLimit:  limit,
		now:          now,
		recentEvents: make([]EventSummary, 0, limit),
		eventsByName: make(map[EventName]uint64),
		reasons:      make(map[ReasonCode]uint64),
	}
}

// Emit records a valid event unless the caller context has already ended.
func (recorder *Recorder) Emit(ctx context.Context, envelope Envelope) error {
	if ctx.Err() != nil {
		return nil
	}
	if err := envelope.Validate(); err != nil {
		return err
	}

	summary := summarizeEnvelope(envelope)

	recorder.mu.Lock()
	defer recorder.mu.Unlock()

	recorder.totalEvents++
	recorder.eventsByName[summary.Event]++
	if summary.ReasonCode != "" {
		recorder.reasons[summary.ReasonCode]++
	}

	if len(recorder.recentEvents) == recorder.recentLimit {
		copy(recorder.recentEvents, recorder.recentEvents[1:])
		recorder.recentEvents[len(recorder.recentEvents)-1] = summary
		recorder.droppedEvents++
		return nil
	}

	recorder.recentEvents = append(recorder.recentEvents, summary)
	return nil
}

// Snapshot returns a detached operator-safe view of the recorder state.
func (recorder *Recorder) Snapshot() Snapshot {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()

	return Snapshot{
		GeneratedAt:   recorder.now().UTC(),
		TotalEvents:   recorder.totalEvents,
		DroppedEvents: recorder.droppedEvents,
		RecentLimit:   recorder.recentLimit,
		RecentEvents:  cloneSummaries(recorder.recentEvents),
		EventsByName:  eventCounts(recorder.eventsByName),
		Reasons:       reasonCounts(recorder.reasons),
	}
}

// DiagnosticsSnapshot satisfies the protected admin diagnostics provider.
func (recorder *Recorder) DiagnosticsSnapshot() Snapshot {
	return recorder.Snapshot()
}

func summarizeEnvelope(envelope Envelope) EventSummary {
	return EventSummary{
		Timestamp:       envelope.Timestamp.UTC(),
		DurationMillis:  envelope.DurationMillis,
		Event:           envelope.Event,
		Level:           envelope.Level,
		ProtocolVersion: sanitizeValue(envelope.ProtocolVersion),
		ReasonCode:      envelope.ReasonCode,
		Attributes:      cloneAttributes(envelope.Attributes),
	}
}

func cloneSummaries(events []EventSummary) []EventSummary {
	copied := make([]EventSummary, len(events))
	for index, event := range events {
		copied[index] = event
		copied[index].Attributes = cloneAttributes(event.Attributes)
	}
	return copied
}

func cloneAttributes(attributes map[AttributeKey]string) map[AttributeKey]string {
	if len(attributes) == 0 {
		return nil
	}

	copied := make(map[AttributeKey]string, len(attributes))
	for key, value := range attributes {
		if AllowedAttribute(key) && !forbiddenValue(value) {
			copied[key] = sanitizeValue(value)
		}
	}
	return copied
}

func eventCounts(counts map[EventName]uint64) []EventCount {
	events := make([]EventName, 0, len(counts))
	for event := range counts {
		events = append(events, event)
	}
	sort.Slice(events, func(left, right int) bool {
		return events[left] < events[right]
	})

	result := make([]EventCount, 0, len(events))
	for _, event := range events {
		result = append(result, EventCount{Event: event, Count: counts[event]})
	}
	return result
}

func reasonCounts(counts map[ReasonCode]uint64) []ReasonCount {
	reasons := make([]ReasonCode, 0, len(counts))
	for reason := range counts {
		reasons = append(reasons, reason)
	}
	sort.Slice(reasons, func(left, right int) bool {
		return reasons[left] < reasons[right]
	})

	result := make([]ReasonCount, 0, len(reasons))
	for _, reason := range reasons {
		result = append(result, ReasonCount{Reason: reason, Count: counts[reason]})
	}
	return result
}
