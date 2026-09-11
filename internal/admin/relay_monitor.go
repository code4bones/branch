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

	"github.com/code4bones/branch/internal/observability"
	protocol "github.com/code4bones/branch/protocol/v0"
)

const (
	DefaultRelayMonitorTTL        = 5 * time.Minute
	DefaultRelayMonitorStaleAfter = 90 * time.Second
	DefaultRelayMonitorMaxEntries = 64

	maxRelayMonitorIDLength         = 64
	maxRelayMonitorEndpointLength   = 512
	maxRelayMonitorServiceLength    = 96
	maxRelayMonitorVersionLength    = 96
	maxRelayMonitorItems            = 16
	maxRelayMonitorItemLength       = 96
	maxRelayMonitorCounter          = 1_000_000_000
	maxRelayMonitorWrapperLength    = 8192
	maxRelayMonitorDiagnosticEvents = 16
	maxRelayMonitorDurationMillis   = 120_000
)

var (
	ErrRelayMonitorInvalidReport = errors.New("relay monitor invalid report")
	ErrRelayMonitorFull          = errors.New("relay monitor registry full")
	relayMonitorWrapperPattern   = regexp.MustCompile(`^BRANCH0\.[A-Za-z0-9_-]+$`)
	relayMonitorPeerRefPattern   = regexp.MustCompile(`^peer-[1-9][0-9]*$`)
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
	RelayID           string                         `json:"relay_id"`
	PublicEndpoint    string                         `json:"public_endpoint"`
	ReportedAt        time.Time                      `json:"reported_at"`
	Snapshot          StatusSnapshot                 `json:"snapshot"`
	BootstrapBeacon   *RelayMonitorBootstrapBeacon   `json:"bootstrap_beacon,omitempty"`
	Federation        []RelayMonitorFederationLink   `json:"federation,omitempty"`
	FederationCarrier *RelayMonitorFederationCarrier `json:"federation_carrier,omitempty"`
	Diagnostics       *RelayMonitorDiagnostics       `json:"diagnostics,omitempty"`
}

// RelayMonitorObservation is the MASTER-side operator view of one relay report.
type RelayMonitorObservation struct {
	RelayID           string                         `json:"relay_id"`
	PublicEndpoint    string                         `json:"public_endpoint"`
	ReportedAt        time.Time                      `json:"reported_at"`
	LastSeenAt        time.Time                      `json:"last_seen_at"`
	ExpiresAt         time.Time                      `json:"expires_at"`
	Stale             bool                           `json:"stale"`
	Snapshot          StatusSnapshot                 `json:"snapshot"`
	BootstrapBeacon   *RelayMonitorBootstrapBeacon   `json:"bootstrap_beacon,omitempty"`
	Federation        []RelayMonitorFederationLink   `json:"federation,omitempty"`
	FederationCarrier *RelayMonitorFederationCarrier `json:"federation_carrier,omitempty"`
	Diagnostics       *RelayMonitorDiagnostics       `json:"diagnostics,omitempty"`
}

// RelayMonitorDiagnostics is a bounded redacted recent-event slice. It is
// optional beta monitoring metadata, never a relay input or durable log store.
type RelayMonitorDiagnostics struct {
	TotalEvents   uint64                        `json:"total_events"`
	DroppedEvents uint64                        `json:"dropped_events"`
	RecentEvents  []RelayMonitorDiagnosticEvent `json:"recent_events,omitempty"`
}

// RelayMonitorDiagnosticEvent intentionally has no attributes or correlation
// fields, so a centralized beta view cannot acquire route, peer, endpoint,
// session, identity, payload, or secret data.
type RelayMonitorDiagnosticEvent struct {
	Timestamp      time.Time                `json:"timestamp"`
	DurationMillis uint64                   `json:"duration_ms,omitempty"`
	Event          observability.EventName  `json:"event"`
	Level          observability.Level      `json:"level"`
	ReasonCode     observability.ReasonCode `json:"reason_code,omitempty"`
}

// RelayMonitorBootstrapBeacon is a public, relay-owned signed carrier record
// cached in the in-memory monitor registry for operator publication tooling.
type RelayMonitorBootstrapBeacon struct {
	Wrapper   string `json:"wrapper"`
	ExpiresAt int64  `json:"expires_at"`
}

// RelayMonitorFederationLink is an operator-only observation of one relay mesh
// edge. It is not a public directory, identity proof, or routing requirement.
type RelayMonitorFederationLink struct {
	PeerRelayID  string     `json:"peer_relay_id,omitempty"`
	PeerEndpoint string     `json:"peer_endpoint"`
	State        string     `json:"state"`
	LastLookupAt *time.Time `json:"last_lookup_at,omitempty"`
	LastReason   string     `json:"last_reason,omitempty"`
	LookupCount  uint64     `json:"lookup_count"`
	BridgeCount  int        `json:"bridge_count"`
	FreshUntil   *time.Time `json:"fresh_until,omitempty"`
}

// RelayMonitorFederationCarrier is a bounded, process-local summary of the
// most recent carrier lookup. It intentionally excludes carrier responses,
// candidate URLs, relay identities, and user data.
type RelayMonitorFederationCarrier struct {
	Carrier        string     `json:"carrier"`
	State          string     `json:"state"`
	LastLookupAt   *time.Time `json:"last_lookup_at,omitempty"`
	LastReason     string     `json:"last_reason,omitempty"`
	CandidateCount int        `json:"candidate_count"`
	FreshUntil     *time.Time `json:"fresh_until,omitempty"`
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
		RelayID:           report.RelayID,
		PublicEndpoint:    report.PublicEndpoint,
		ReportedAt:        report.ReportedAt.UTC(),
		LastSeenAt:        now.UTC(),
		ExpiresAt:         now.Add(registry.ttl).UTC(),
		Stale:             false,
		Snapshot:          report.Snapshot,
		BootstrapBeacon:   cloneRelayMonitorBootstrapBeacon(report.BootstrapBeacon),
		Federation:        cloneRelayMonitorFederationLinks(report.Federation),
		FederationCarrier: cloneRelayMonitorFederationCarrier(report.FederationCarrier),
		Diagnostics:       cloneRelayMonitorDiagnostics(report.Diagnostics),
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
	if !validRelayMonitorFederationLinks(report.Federation) {
		return ErrRelayMonitorInvalidReport
	}
	if report.FederationCarrier != nil && !validRelayMonitorFederationCarrier(*report.FederationCarrier) {
		return ErrRelayMonitorInvalidReport
	}
	if report.Diagnostics != nil && !validRelayMonitorDiagnostics(*report.Diagnostics) {
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

func validRelayMonitorDiagnostics(diagnostics RelayMonitorDiagnostics) bool {
	if diagnostics.TotalEvents > uint64(maxRelayMonitorCounter) || diagnostics.TotalEvents < uint64(len(diagnostics.RecentEvents)) || diagnostics.DroppedEvents > diagnostics.TotalEvents || len(diagnostics.RecentEvents) > maxRelayMonitorDiagnosticEvents {
		return false
	}
	var previous time.Time
	for _, event := range diagnostics.RecentEvents {
		if event.Timestamp.IsZero() || event.DurationMillis > maxRelayMonitorDurationMillis || !observability.KnownEvent(event.Event) || !observability.KnownLevel(event.Level) {
			return false
		}
		if !previous.IsZero() && event.Timestamp.Before(previous) {
			return false
		}
		previous = event.Timestamp
		if event.ReasonCode != "" && !observability.KnownReason(event.ReasonCode) {
			return false
		}
	}
	return true
}

func cloneRelayMonitorDiagnostics(diagnostics *RelayMonitorDiagnostics) *RelayMonitorDiagnostics {
	if diagnostics == nil {
		return nil
	}
	cloned := &RelayMonitorDiagnostics{
		TotalEvents:   diagnostics.TotalEvents,
		DroppedEvents: diagnostics.DroppedEvents,
		RecentEvents:  make([]RelayMonitorDiagnosticEvent, len(diagnostics.RecentEvents)),
	}
	copy(cloned.RecentEvents, diagnostics.RecentEvents)
	for index := range cloned.RecentEvents {
		cloned.RecentEvents[index].Timestamp = cloned.RecentEvents[index].Timestamp.UTC()
	}
	return cloned
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

func validRelayMonitorFederationLinks(links []RelayMonitorFederationLink) bool {
	if len(links) > maxRelayMonitorItems {
		return false
	}
	seen := make(map[string]struct{}, len(links))
	for _, link := range links {
		if link.PeerRelayID != "" && !validRelayMonitorID(link.PeerRelayID) {
			return false
		}
		if !validRelayMonitorPeerReference(link.PeerEndpoint) {
			return false
		}
		if !validRelayMonitorFederationState(link.State) {
			return false
		}
		if link.LastReason != "" && !validRelayMonitorReason(link.LastReason) {
			return false
		}
		if link.LookupCount > uint64(maxRelayMonitorCounter) || link.BridgeCount < 0 || link.BridgeCount > maxRelayMonitorCounter {
			return false
		}
		if link.LastLookupAt != nil && link.LastLookupAt.IsZero() {
			return false
		}
		if link.FreshUntil != nil && link.FreshUntil.IsZero() {
			return false
		}
		if _, ok := seen[link.PeerEndpoint]; ok {
			return false
		}
		seen[link.PeerEndpoint] = struct{}{}
	}
	return true
}

// validRelayMonitorPeerReference accepts only the process-local reference
// emitted by federation monitoring. The protected monitor API deliberately
// does not publish peer relay endpoints.
func validRelayMonitorPeerReference(value string) bool {
	return validRelayMonitorText(value, 1, maxRelayMonitorEndpointLength) && relayMonitorPeerRefPattern.MatchString(value)
}

func validRelayMonitorFederationState(value string) bool {
	switch value {
	case "configured", "reachable", "unreachable":
		return true
	default:
		return false
	}
}

func validRelayMonitorReason(value string) bool {
	if !validRelayMonitorText(value, 1, maxRelayMonitorItemLength) {
		return false
	}
	for _, char := range value {
		if unicode.IsLetter(char) || unicode.IsDigit(char) || char == '_' || char == '-' || char == '.' {
			continue
		}
		return false
	}
	return true
}

func cloneRelayMonitorFederationLinks(links []RelayMonitorFederationLink) []RelayMonitorFederationLink {
	if len(links) == 0 {
		return nil
	}
	cloned := make([]RelayMonitorFederationLink, 0, len(links))
	for _, link := range links {
		cloned = append(cloned, RelayMonitorFederationLink{
			PeerRelayID:  link.PeerRelayID,
			PeerEndpoint: link.PeerEndpoint,
			State:        link.State,
			LastLookupAt: cloneTimePtr(link.LastLookupAt),
			LastReason:   link.LastReason,
			LookupCount:  link.LookupCount,
			BridgeCount:  link.BridgeCount,
			FreshUntil:   cloneTimePtr(link.FreshUntil),
		})
	}
	return cloned
}

func validRelayMonitorFederationCarrier(carrier RelayMonitorFederationCarrier) bool {
	if !validRelayMonitorText(carrier.Carrier, 1, maxRelayMonitorItemLength) || !validRelayMonitorFederationCarrierState(carrier.State) {
		return false
	}
	if carrier.LastReason != "" && !validRelayMonitorReason(carrier.LastReason) {
		return false
	}
	if carrier.CandidateCount < 0 || carrier.CandidateCount > maxRelayMonitorItems {
		return false
	}
	if carrier.LastLookupAt == nil || carrier.LastLookupAt.IsZero() || carrier.FreshUntil == nil || carrier.FreshUntil.IsZero() {
		return false
	}
	return carrier.FreshUntil.After(*carrier.LastLookupAt)
}

func validRelayMonitorFederationCarrierState(value string) bool {
	return value == "ready" || value == "unavailable"
}

func cloneRelayMonitorFederationCarrier(carrier *RelayMonitorFederationCarrier) *RelayMonitorFederationCarrier {
	if carrier == nil {
		return nil
	}
	return &RelayMonitorFederationCarrier{
		Carrier:        carrier.Carrier,
		State:          carrier.State,
		LastLookupAt:   cloneTimePtr(carrier.LastLookupAt),
		LastReason:     carrier.LastReason,
		CandidateCount: carrier.CandidateCount,
		FreshUntil:     cloneTimePtr(carrier.FreshUntil),
	}
}

func cloneTimePtr(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	cloned := value.UTC()
	return &cloned
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
