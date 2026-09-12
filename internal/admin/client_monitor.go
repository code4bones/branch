package admin

import (
	"errors"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	DefaultClientMonitorTTL        = 15 * time.Minute
	DefaultClientMonitorMaxClients = 16
	DefaultClientMonitorMaxEvents  = 192
	maxClientMonitorBatchEvents    = 24
	maxClientMonitorSequence       = 1_000_000_000
)

var (
	ErrClientMonitorInvalidReport = errors.New("client monitor invalid report")
	ErrClientMonitorFull          = errors.New("client monitor registry full")
	clientMonitorRefPattern       = regexp.MustCompile(`^[a-f0-9]{32}$`)
	clientMonitorReleasePattern   = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+$`)
	clientMonitorRelayPattern     = regexp.MustCompile(`^relay[0-9]{2}$`)
	clientMonitorOutboxRefPattern = regexp.MustCompile(`^m[1-9][0-9]{0,2}$`)
)

// ClientMonitorReport is a deliberately redacted, development-only PWA trace
// batch. It has no permanent user, relay URL, route, message, delivery, or
// protocol-session identifier.
type ClientMonitorReport struct {
	SessionRef string                `json:"session_ref"`
	Release    string                `json:"release"`
	Sequence   uint64                `json:"sequence"`
	Snapshot   ClientMonitorSnapshot `json:"snapshot"`
	Events     []ClientMonitorEvent  `json:"events"`
}

// ClientMonitorSnapshot is a closed, tab-local diagnostic state projection.
// It deliberately contains no BranchID, peer/contact, message, delivery,
// route, capability, or cryptographic identifier. relay is an optional label
// for a project-controlled development relay, not an address or URL.
type ClientMonitorSnapshot struct {
	Identity    string                    `json:"identity"`
	Page        string                    `json:"page"`
	Route       string                    `json:"route"`
	Attach      string                    `json:"attach"`
	Relay       string                    `json:"relay"`
	RTC         string                    `json:"rtc"`
	Discovery   string                    `json:"discovery"`
	Filters     []string                  `json:"filters"`
	Contacts    string                    `json:"contacts"`
	Presence    string                    `json:"presence"`
	Outbox      string                    `json:"outbox"`
	OutboxItems []ClientMonitorOutboxItem `json:"outbox_items"`
	ReadWork    string                    `json:"read_work"`
	Attachments string                    `json:"attachments"`
}

// ClientMonitorOutboxItem is an opaque, session-local display handle. The
// browser retains the real message ID locally and may only export m1..m32
// plus its current local receipt stage.
type ClientMonitorOutboxItem struct {
	Ref   string `json:"ref"`
	State string `json:"state"`
}

// ClientMonitorEvent contains only an allow-listed diagnostic outcome and a
// browser wall-clock timestamp. Event names are not arbitrary trace strings.
type ClientMonitorEvent struct {
	At       time.Time             `json:"at"`
	Category string                `json:"category"`
	Event    string                `json:"event"`
	Message  *ClientMonitorMessage `json:"message,omitempty"`
}

// ClientMonitorMessage is an opaque browser-session-only handle and closed
// state. It has no message, delivery, contact or peer identifier.
type ClientMonitorMessage struct {
	Ref       string `json:"ref"`
	Direction string `json:"direction"`
	Status    string `json:"status"`
}

// ClientMonitorObservation is the process-local operator view for one tab.
// Restarting the node forgets every observation.
type ClientMonitorObservation struct {
	SessionRef string                `json:"session_ref"`
	Release    string                `json:"release"`
	Sequence   uint64                `json:"sequence"`
	Snapshot   ClientMonitorSnapshot `json:"snapshot"`
	LastSeenAt time.Time             `json:"last_seen_at"`
	ExpiresAt  time.Time             `json:"expires_at"`
	Events     []ClientMonitorEvent  `json:"events"`
}

// ClientMonitorConfig controls the bounded, memory-only client registry.
type ClientMonitorConfig struct {
	TTL        time.Duration
	MaxClients int
	MaxEvents  int
	Journal    ClientMonitorJournal
}

// ClientMonitorRegistry stores development observations only in process
// memory. It is not a relay queue, connectivity input, or durable log store.
type ClientMonitorRegistry struct {
	mu         sync.Mutex
	entries    map[string]ClientMonitorObservation
	ttl        time.Duration
	maxClients int
	maxEvents  int
	journal    ClientMonitorJournal
}

func NewClientMonitorRegistry(config ClientMonitorConfig) *ClientMonitorRegistry {
	if config.TTL <= 0 {
		config.TTL = DefaultClientMonitorTTL
	}
	if config.MaxClients <= 0 {
		config.MaxClients = DefaultClientMonitorMaxClients
	}
	if config.MaxEvents <= 0 {
		config.MaxEvents = DefaultClientMonitorMaxEvents
	}
	return &ClientMonitorRegistry{entries: make(map[string]ClientMonitorObservation), ttl: config.TTL, maxClients: config.MaxClients, maxEvents: config.MaxEvents, journal: config.Journal}
}

func (registry *ClientMonitorRegistry) Accept(report ClientMonitorReport, now time.Time) error {
	if !validClientMonitorReport(report) {
		return ErrClientMonitorInvalidReport
	}
	registry.mu.Lock()
	defer registry.mu.Unlock()
	registry.pruneLocked(now)
	observation, exists := registry.entries[report.SessionRef]
	if !exists && len(registry.entries) >= registry.maxClients {
		return ErrClientMonitorFull
	}
	observation.SessionRef = report.SessionRef
	observation.Release = report.Release
	observation.Sequence = report.Sequence
	observation.Snapshot = cloneClientMonitorSnapshot(report.Snapshot)
	observation.LastSeenAt = now.UTC()
	observation.ExpiresAt = now.Add(registry.ttl).UTC()
	observation.Events = append(observation.Events, cloneClientMonitorEvents(report.Events)...)
	if len(observation.Events) > registry.maxEvents {
		observation.Events = observation.Events[len(observation.Events)-registry.maxEvents:]
	}
	registry.entries[report.SessionRef] = observation
	if registry.journal != nil {
		registry.journal.Record(report, now)
	}
	return nil
}

func (registry *ClientMonitorRegistry) List(now time.Time) []ClientMonitorObservation {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	registry.pruneLocked(now)
	observations := make([]ClientMonitorObservation, 0, len(registry.entries))
	for _, observation := range registry.entries {
		observation.Events = cloneClientMonitorEvents(observation.Events)
		observation.Snapshot = cloneClientMonitorSnapshot(observation.Snapshot)
		observations = append(observations, observation)
	}
	sort.Slice(observations, func(left, right int) bool { return observations[left].SessionRef < observations[right].SessionRef })
	return observations
}

func (registry *ClientMonitorRegistry) pruneLocked(now time.Time) {
	for clientRef, observation := range registry.entries {
		if !now.Before(observation.ExpiresAt) {
			delete(registry.entries, clientRef)
		}
	}
}

func validClientMonitorReport(report ClientMonitorReport) bool {
	if !clientMonitorRefPattern.MatchString(report.SessionRef) || !clientMonitorReleasePattern.MatchString(report.Release) || report.Sequence == 0 || report.Sequence > maxClientMonitorSequence || len(report.Events) == 0 || len(report.Events) > maxClientMonitorBatchEvents || !validClientMonitorSnapshot(report.Snapshot) {
		return false
	}
	for _, event := range report.Events {
		if event.At.IsZero() || !validClientMonitorCategory(event.Category) || !validClientMonitorEvent(event.Event) || !validClientMonitorEventMessage(event) {
			return false
		}
	}
	return true
}

func validClientMonitorSnapshot(snapshot ClientMonitorSnapshot) bool {
	if !oneOf(snapshot.Identity, "unknown", "missing", "ready") || !oneOf(snapshot.Page, "onboarding", "discovery", "chats", "requests", "settings", "other") || !oneOf(snapshot.Route, "idle", "searching", "found", "failed") || !oneOf(snapshot.Attach, "idle", "attaching", "attached", "error") || !oneOf(snapshot.RTC, "not_observed", "signaling_observed") || !oneOf(snapshot.Discovery, "unavailable", "ready", "disabled", "unsupported") || !oneOf(snapshot.Contacts, "zero", "one", "two_to_four", "five_to_eight", "nine_plus") || !oneOf(snapshot.Presence, "zero", "one", "two_to_four", "five_to_eight", "nine_plus") || !oneOf(snapshot.Outbox, "zero", "one", "two_to_four", "five_to_eight", "nine_plus") || !oneOf(snapshot.ReadWork, "zero", "one", "two_to_four", "five_to_eight", "nine_plus") || !oneOf(snapshot.Attachments, "zero", "one", "two_to_four", "five_to_eight", "nine_plus") {
		return false
	}
	if snapshot.Relay != "none" && !clientMonitorRelayPattern.MatchString(snapshot.Relay) {
		return false
	}
	if len(snapshot.Filters) > 7 {
		return false
	}
	seen := make(map[string]struct{}, len(snapshot.Filters))
	for _, category := range snapshot.Filters {
		if !validClientMonitorCategory(category) || strings.TrimSpace(category) != category {
			return false
		}
		if _, exists := seen[category]; exists {
			return false
		}
		seen[category] = struct{}{}
	}
	if len(snapshot.OutboxItems) > 32 {
		return false
	}
	itemRefs := make(map[string]struct{}, len(snapshot.OutboxItems))
	for _, item := range snapshot.OutboxItems {
		if !clientMonitorOutboxRefPattern.MatchString(item.Ref) || !oneOf(item.State, "awaiting_delivery", "awaiting_read") {
			return false
		}
		if _, exists := itemRefs[item.Ref]; exists {
			return false
		}
		itemRefs[item.Ref] = struct{}{}
	}
	return true
}

func oneOf(value string, allowed ...string) bool {
	for _, candidate := range allowed {
		if value == candidate {
			return true
		}
	}
	return false
}

func validClientMonitorCategory(category string) bool {
	switch category {
	case "messages", "presence", "receipts", "outbox", "controls", "transport", "frames":
		return true
	default:
		return false
	}
}

func validClientMonitorEvent(event string) bool {
	switch event {
	case "client.session_started", "receipt.read_expired", "receipt.read_attempt_sent", "receipt.read_skipped", "receipt.read_failed", "receipt.read_matched", "receipt.read_unmatched", "receipt.read_accepted", "receipt.read_duplicate_terminal", "receipt.delivered_failed", "receipt.delivered_sent", "receipt.delivered_matched", "receipt.delivered_unmatched", "outbox.expired", "outbox.retry_deferred", "outbox.retry_sent", "message.received", "message.duplicate", "message.request", "message.observed", "message.status_changed", "transport.attached", "transport.attach_failed", "transport.relay_notice", "transport.disconnected", "frame.outbound", "frame.incoming", "control.capability", "control.typing", "control.rtc", "poc.burst_started", "poc.burst_queued", "poc.rendezvous_sent", "poc.rendezvous_failed":
		return true
	default:
		return false
	}
}

func validClientMonitorEventMessage(event ClientMonitorEvent) bool {
	if event.Message == nil {
		return event.Event != "message.observed" && event.Event != "message.status_changed"
	}
	message := event.Message
	if event.Category != "messages" || (event.Event != "message.observed" && event.Event != "message.status_changed") || !clientMonitorOutboxRefPattern.MatchString(message.Ref) {
		return false
	}
	if message.Direction == "incoming" {
		return message.Status == "received"
	}
	return message.Direction == "outgoing" && oneOf(message.Status, "pending", "relayed", "delivered", "read", "unavailable")
}

func cloneClientMonitorSnapshot(snapshot ClientMonitorSnapshot) ClientMonitorSnapshot {
	snapshot.Filters = append([]string(nil), snapshot.Filters...)
	snapshot.OutboxItems = append([]ClientMonitorOutboxItem(nil), snapshot.OutboxItems...)
	return snapshot
}

func cloneClientMonitorEvents(events []ClientMonitorEvent) []ClientMonitorEvent {
	cloned := make([]ClientMonitorEvent, len(events))
	copy(cloned, events)
	for index := range cloned {
		cloned[index].At = cloned[index].At.UTC()
		if events[index].Message != nil {
			message := *events[index].Message
			cloned[index].Message = &message
		}
	}
	return cloned
}

func httpStatusForClientMonitorError(err error) int {
	if errors.Is(err, ErrClientMonitorFull) {
		return http.StatusServiceUnavailable
	}
	return http.StatusBadRequest
}
