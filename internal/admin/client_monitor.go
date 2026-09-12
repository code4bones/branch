package admin

import (
	"errors"
	"net/http"
	"regexp"
	"sort"
	"sync"
	"time"
)

const (
	DefaultClientMonitorTTL        = 15 * time.Minute
	DefaultClientMonitorMaxClients = 16
	DefaultClientMonitorMaxEvents  = 192
	maxClientMonitorBatchEvents    = 24
)

var (
	ErrClientMonitorInvalidReport = errors.New("client monitor invalid report")
	ErrClientMonitorFull          = errors.New("client monitor registry full")
	clientMonitorRefPattern       = regexp.MustCompile(`^[a-f0-9]{32}$`)
	clientMonitorReleasePattern   = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+$`)
)

// ClientMonitorReport is a deliberately redacted, development-only PWA
// trace batch. It has no user, relay, route, message, delivery, or session ID.
type ClientMonitorReport struct {
	ClientRef string               `json:"client_ref"`
	Release   string               `json:"release"`
	Events    []ClientMonitorEvent `json:"events"`
}

// ClientMonitorEvent contains only an allow-listed diagnostic outcome and a
// browser wall-clock timestamp. Event names are not arbitrary trace strings.
type ClientMonitorEvent struct {
	At       time.Time `json:"at"`
	Category string    `json:"category"`
	Event    string    `json:"event"`
}

// ClientMonitorObservation is the process-local operator view for one tab.
// Restarting the node forgets every observation.
type ClientMonitorObservation struct {
	ClientRef  string               `json:"client_ref"`
	Release    string               `json:"release"`
	LastSeenAt time.Time            `json:"last_seen_at"`
	ExpiresAt  time.Time            `json:"expires_at"`
	Events     []ClientMonitorEvent `json:"events"`
}

// ClientMonitorConfig controls the bounded, memory-only client registry.
type ClientMonitorConfig struct {
	TTL        time.Duration
	MaxClients int
	MaxEvents  int
}

// ClientMonitorRegistry stores development observations only in process
// memory. It is not a relay queue, connectivity input, or durable log store.
type ClientMonitorRegistry struct {
	mu         sync.Mutex
	entries    map[string]ClientMonitorObservation
	ttl        time.Duration
	maxClients int
	maxEvents  int
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
	return &ClientMonitorRegistry{entries: make(map[string]ClientMonitorObservation), ttl: config.TTL, maxClients: config.MaxClients, maxEvents: config.MaxEvents}
}

func (registry *ClientMonitorRegistry) Accept(report ClientMonitorReport, now time.Time) error {
	if !validClientMonitorReport(report) {
		return ErrClientMonitorInvalidReport
	}
	registry.mu.Lock()
	defer registry.mu.Unlock()
	registry.pruneLocked(now)
	observation, exists := registry.entries[report.ClientRef]
	if !exists && len(registry.entries) >= registry.maxClients {
		return ErrClientMonitorFull
	}
	observation.ClientRef = report.ClientRef
	observation.Release = report.Release
	observation.LastSeenAt = now.UTC()
	observation.ExpiresAt = now.Add(registry.ttl).UTC()
	observation.Events = append(observation.Events, cloneClientMonitorEvents(report.Events)...)
	if len(observation.Events) > registry.maxEvents {
		observation.Events = observation.Events[len(observation.Events)-registry.maxEvents:]
	}
	registry.entries[report.ClientRef] = observation
	return nil
}

func (registry *ClientMonitorRegistry) List(now time.Time) []ClientMonitorObservation {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	registry.pruneLocked(now)
	observations := make([]ClientMonitorObservation, 0, len(registry.entries))
	for _, observation := range registry.entries {
		observation.Events = cloneClientMonitorEvents(observation.Events)
		observations = append(observations, observation)
	}
	sort.Slice(observations, func(left, right int) bool { return observations[left].ClientRef < observations[right].ClientRef })
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
	if !clientMonitorRefPattern.MatchString(report.ClientRef) || !clientMonitorReleasePattern.MatchString(report.Release) || len(report.Events) == 0 || len(report.Events) > maxClientMonitorBatchEvents {
		return false
	}
	for _, event := range report.Events {
		if event.At.IsZero() || !validClientMonitorCategory(event.Category) || !validClientMonitorEvent(event.Event) {
			return false
		}
	}
	return true
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
	case "receipt.read_expired", "receipt.read_attempt_sent", "receipt.read_skipped", "receipt.read_failed", "receipt.read_matched", "receipt.read_unmatched", "receipt.delivered_failed", "receipt.delivered_sent", "receipt.delivered_matched", "receipt.delivered_unmatched", "outbox.expired", "outbox.retry_deferred", "outbox.retry_sent", "message.received", "message.duplicate", "message.request", "transport.attached", "transport.attach_failed", "transport.relay_notice", "transport.disconnected", "frame.outbound", "frame.incoming", "control.capability", "control.typing", "control.rtc", "poc.burst_started", "poc.burst_queued", "poc.rendezvous_sent", "poc.rendezvous_failed":
		return true
	default:
		return false
	}
}

func cloneClientMonitorEvents(events []ClientMonitorEvent) []ClientMonitorEvent {
	cloned := make([]ClientMonitorEvent, len(events))
	copy(cloned, events)
	for index := range cloned {
		cloned[index].At = cloned[index].At.UTC()
	}
	return cloned
}

func httpStatusForClientMonitorError(err error) int {
	if errors.Is(err, ErrClientMonitorFull) {
		return http.StatusServiceUnavailable
	}
	return http.StatusBadRequest
}
