package admin

import (
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"

	protocol "github.com/code4bones/branch/protocol/v0"
)

const (
	DefaultRelayMonitorTTL        = 5 * time.Minute
	DefaultRelayMonitorStaleAfter = 90 * time.Second
	DefaultRelayMonitorMaxEntries = 64

	maxRelayMonitorIDLength       = 64
	maxRelayMonitorEndpointLength = 512
	maxRelayMonitorServiceLength  = 96
	maxRelayMonitorVersionLength  = 96
	maxRelayMonitorItems          = 16
	maxRelayMonitorItemLength     = 96
	maxRelayMonitorCounter        = 1_000_000_000
	maxRelayMonitorWrapperLength  = 8192
)

var (
	ErrRelayMonitorInvalidReport = errors.New("relay monitor invalid report")
	ErrRelayMonitorFull          = errors.New("relay monitor registry full")
	relayMonitorWrapperPattern   = regexp.MustCompile(`^BRANCH0\.[A-Za-z0-9_-]+$`)
)

// RelayMonitorConfig controls the process-local in-memory relay observation
// registry.
type RelayMonitorConfig struct {
	TTL        time.Duration
	StaleAfter time.Duration
	MaxEntries int
}

// RelayMonitorReport is the bounded status envelope pushed by one relay node.
type RelayMonitorReport struct {
	RelayID         string                       `json:"relay_id"`
	PublicEndpoint  string                       `json:"public_endpoint"`
	ReportedAt      time.Time                    `json:"reported_at"`
	Snapshot        StatusSnapshot               `json:"snapshot"`
	BootstrapBeacon *RelayMonitorBootstrapBeacon `json:"bootstrap_beacon,omitempty"`
}

// RelayMonitorObservation is the MASTER-side operator view of one relay report.
type RelayMonitorObservation struct {
	RelayID         string                       `json:"relay_id"`
	PublicEndpoint  string                       `json:"public_endpoint"`
	ReportedAt      time.Time                    `json:"reported_at"`
	LastSeenAt      time.Time                    `json:"last_seen_at"`
	ExpiresAt       time.Time                    `json:"expires_at"`
	Stale           bool                         `json:"stale"`
	Snapshot        StatusSnapshot               `json:"snapshot"`
	BootstrapBeacon *RelayMonitorBootstrapBeacon `json:"bootstrap_beacon,omitempty"`
}

// RelayMonitorBootstrapBeacon is a public, relay-owned signed carrier record
// cached in the in-memory monitor registry for operator publication tooling.
type RelayMonitorBootstrapBeacon struct {
	Wrapper   string `json:"wrapper"`
	ExpiresAt int64  `json:"expires_at"`
}

// RelayMonitorRegistry stores recent relay observations in memory only. A
// process restart forgets every report.
type RelayMonitorRegistry struct {
	mu         sync.Mutex
	entries    map[string]RelayMonitorObservation
	ttl        time.Duration
	staleAfter time.Duration
	maxEntries int
}

// NewRelayMonitorRegistry creates a bounded in-memory relay observation
// registry.
func NewRelayMonitorRegistry(config RelayMonitorConfig) *RelayMonitorRegistry {
	if config.TTL <= 0 {
		config.TTL = DefaultRelayMonitorTTL
	}
	if config.StaleAfter <= 0 {
		config.StaleAfter = DefaultRelayMonitorStaleAfter
	}
	if config.MaxEntries <= 0 {
		config.MaxEntries = DefaultRelayMonitorMaxEntries
	}
	return &RelayMonitorRegistry{
		entries:    make(map[string]RelayMonitorObservation),
		ttl:        config.TTL,
		staleAfter: config.StaleAfter,
		maxEntries: config.MaxEntries,
	}
}

// Accept validates and stores one relay report with process-local freshness
// metadata.
func (registry *RelayMonitorRegistry) Accept(report RelayMonitorReport, now time.Time) error {
	if err := validateRelayMonitorReport(report); err != nil {
		return err
	}
	registry.mu.Lock()
	defer registry.mu.Unlock()

	registry.pruneLocked(now)
	if _, ok := registry.entries[report.RelayID]; !ok && len(registry.entries) >= registry.maxEntries {
		return ErrRelayMonitorFull
	}
	report.Snapshot = sanitizeSnapshot(report.Snapshot)
	if report.ReportedAt.IsZero() {
		report.ReportedAt = now.UTC()
	}
	registry.entries[report.RelayID] = RelayMonitorObservation{
		RelayID:         report.RelayID,
		PublicEndpoint:  report.PublicEndpoint,
		ReportedAt:      report.ReportedAt.UTC(),
		LastSeenAt:      now.UTC(),
		ExpiresAt:       now.Add(registry.ttl).UTC(),
		Stale:           false,
		Snapshot:        report.Snapshot,
		BootstrapBeacon: cloneRelayMonitorBootstrapBeacon(report.BootstrapBeacon),
	}
	return nil
}

// List returns non-expired observations. Expired reports are forgotten.
func (registry *RelayMonitorRegistry) List(now time.Time) []RelayMonitorObservation {
	registry.mu.Lock()
	defer registry.mu.Unlock()

	registry.pruneLocked(now)
	observations := make([]RelayMonitorObservation, 0, len(registry.entries))
	for _, observation := range registry.entries {
		observation.Stale = now.Sub(observation.LastSeenAt) > registry.staleAfter
		observations = append(observations, observation)
	}
	sort.Slice(observations, func(left int, right int) bool {
		return observations[left].RelayID < observations[right].RelayID
	})
	return observations
}

func (registry *RelayMonitorRegistry) pruneLocked(now time.Time) {
	for relayID, observation := range registry.entries {
		if !now.Before(observation.ExpiresAt) {
			delete(registry.entries, relayID)
		}
	}
}

func validateRelayMonitorReport(report RelayMonitorReport) error {
	if !validRelayMonitorID(report.RelayID) {
		return ErrRelayMonitorInvalidReport
	}
	if !validRelayMonitorEndpoint(report.PublicEndpoint) {
		return ErrRelayMonitorInvalidReport
	}
	if !validRelayMonitorText(report.Snapshot.ServiceName, 1, maxRelayMonitorServiceLength) {
		return ErrRelayMonitorInvalidReport
	}
	if !validRelayMonitorText(report.Snapshot.ServiceVersion, 1, maxRelayMonitorVersionLength) {
		return ErrRelayMonitorInvalidReport
	}
	if !validReadiness(report.Snapshot.Readiness) {
		return ErrRelayMonitorInvalidReport
	}
	if !validRelayMonitorItems(report.Snapshot.ProtocolVersions) || !validRelayMonitorItems(report.Snapshot.Capabilities) {
		return ErrRelayMonitorInvalidReport
	}
	if report.BootstrapBeacon != nil && !validRelayMonitorBootstrapBeacon(*report.BootstrapBeacon) {
		return ErrRelayMonitorInvalidReport
	}
	for _, counter := range []int{
		report.Snapshot.SessionsActive,
		report.Snapshot.RoutesActive,
		report.Snapshot.PresenceActive,
		report.Snapshot.QueueDepth,
	} {
		if counter < 0 || counter > maxRelayMonitorCounter {
			return ErrRelayMonitorInvalidReport
		}
	}
	return nil
}

func validRelayMonitorBootstrapBeacon(beacon RelayMonitorBootstrapBeacon) bool {
	if beacon.ExpiresAt <= 0 {
		return false
	}
	if len(beacon.Wrapper) == 0 || len(beacon.Wrapper) > maxRelayMonitorWrapperLength {
		return false
	}
	if !strings.HasPrefix(beacon.Wrapper, protocol.BranchTextWrapperPrefix) {
		return false
	}
	return relayMonitorWrapperPattern.MatchString(beacon.Wrapper)
}

func cloneRelayMonitorBootstrapBeacon(beacon *RelayMonitorBootstrapBeacon) *RelayMonitorBootstrapBeacon {
	if beacon == nil {
		return nil
	}
	return &RelayMonitorBootstrapBeacon{
		Wrapper:   beacon.Wrapper,
		ExpiresAt: beacon.ExpiresAt,
	}
}

func validRelayMonitorID(value string) bool {
	if len(value) == 0 || len(value) > maxRelayMonitorIDLength {
		return false
	}
	for _, char := range value {
		if unicode.IsLetter(char) || unicode.IsDigit(char) || char == '-' || char == '_' || char == '.' {
			continue
		}
		return false
	}
	return true
}

func validRelayMonitorEndpoint(value string) bool {
	if !validRelayMonitorText(value, 1, maxRelayMonitorEndpointLength) {
		return false
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return false
	}
	return (parsed.Scheme == "wss" || parsed.Scheme == "ws") && parsed.Host != ""
}

func validRelayMonitorText(value string, minLength int, maxLength int) bool {
	trimmed := strings.TrimSpace(value)
	return len(trimmed) >= minLength && len(trimmed) <= maxLength && trimmed == value
}

func validRelayMonitorItems(values []string) bool {
	if len(values) == 0 || len(values) > maxRelayMonitorItems {
		return false
	}
	for _, value := range values {
		if !validRelayMonitorText(value, 1, maxRelayMonitorItemLength) {
			return false
		}
	}
	return true
}

func validReadiness(readiness ReadinessState) bool {
	switch readiness {
	case ReadinessReady, ReadinessDegraded, ReadinessNotReady:
		return true
	default:
		return false
	}
}

func httpStatusForRelayMonitorError(err error) int {
	if errors.Is(err, ErrRelayMonitorFull) {
		return http.StatusServiceUnavailable
	}
	return http.StatusBadRequest
}
