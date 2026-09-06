package discovery

import (
	"errors"
	"sort"
	"strings"
	"sync"
	"time"

	protocolv0 "github.com/code4bones/branch/protocol/v0"
)

const (
	defaultIdentityContactCacheEntries = 512
	maxIdentityContactSourceBytes      = 512
)

// IdentityContactCache keeps bounded volatile observations of signed
// identity.announce source records. It is intentionally memory-only: a fresh
// cache starts empty and relay restart forgets every observation.
type IdentityContactCache struct {
	mu         sync.Mutex
	maxEntries int
	now        func() time.Time
	entries    map[string]IdentityContactObservation
}

// IdentityContactCacheConfig defines local operator bounds for the in-memory
// observation cache.
type IdentityContactCacheConfig struct {
	MaxEntries int
	Now        func() time.Time
}

// IdentityContactObservation is the safe control-plane projection stored in
// the relay cache. Wrapper is retained so a receiver can revalidate the exact
// signed source record.
type IdentityContactObservation struct {
	BranchID           string
	Sequence           uint64
	ExpiresAtUnix      int64
	IssuedAtUnix       int64
	LastObservedUnix   int64
	Source             string
	Wrapper            string
	SenderPublicKey    []byte
	ProtocolVersions   []string
	ProfileMultihashes []string
	RouteHints         []protocolv0.IdentityContactRouteHint
}

// IdentityContactCacheResult reports whether an observation changed the cache.
type IdentityContactCacheResult struct {
	Accepted    bool
	Reason      protocolv0.IdentityContactValidationReason
	Observation *IdentityContactObservation
}

// NewIdentityContactCache creates a bounded in-memory IdentityContact cache.
func NewIdentityContactCache(config IdentityContactCacheConfig) (*IdentityContactCache, error) {
	maxEntries := config.MaxEntries
	if maxEntries == 0 {
		maxEntries = defaultIdentityContactCacheEntries
	}
	if maxEntries < 0 {
		return nil, errors.New("invalid identity contact cache size")
	}
	now := config.Now
	if now == nil {
		now = time.Now
	}
	return &IdentityContactCache{
		maxEntries: maxEntries,
		now:        now,
		entries:    make(map[string]IdentityContactObservation),
	}, nil
}

// Accept validates and stores one public identity.announce wrapper. It keeps
// the newest non-expired sequence for the exact BranchID and evicts old
// observations when the cache reaches its configured bound. An exact wrapper
// duplicate is idempotent; a different canonical wrapper at the same sequence
// is rejected as equivocation rather than using carrier arrival order.
func (cache *IdentityContactCache) Accept(wrapper string, source string, options protocolv0.IdentityContactValidationOptions) IdentityContactCacheResult {
	cache.mu.Lock()
	defer cache.mu.Unlock()

	nowUnix := cache.now().Unix()
	if options.NowUnix == 0 {
		options.NowUnix = nowUnix
	}
	result := protocolv0.ValidateBranchTextIdentityContact(wrapper, options)
	if !result.Accepted || result.Contact == nil {
		return IdentityContactCacheResult{Reason: result.Reason}
	}
	contact := result.Contact
	branchID := contact.Payload.BranchID
	cache.pruneExpiredLocked(nowUnix)
	if existing, ok := cache.entries[branchID]; ok {
		switch {
		case contact.Payload.Sequence < existing.Sequence:
			return IdentityContactCacheResult{Reason: protocolv0.IdentityContactLowerSequence}
		case contact.Payload.Sequence == existing.Sequence && contact.Wrapper != existing.Wrapper:
			return IdentityContactCacheResult{Reason: protocolv0.IdentityContactEquivocation}
		case contact.Payload.Sequence == existing.Sequence:
			cloned := cloneIdentityContactObservation(existing)
			return IdentityContactCacheResult{
				Accepted:    true,
				Reason:      protocolv0.IdentityContactAccepted,
				Observation: &cloned,
			}
		}
	}
	if _, exists := cache.entries[branchID]; !exists && cache.maxEntries == 0 {
		return IdentityContactCacheResult{Reason: protocolv0.IdentityContactPayloadInvalid}
	}
	if _, exists := cache.entries[branchID]; !exists && len(cache.entries) >= cache.maxEntries {
		cache.evictOldestLocked()
	}

	observation := IdentityContactObservation{
		BranchID:           branchID,
		Sequence:           contact.Payload.Sequence,
		ExpiresAtUnix:      contact.Payload.ExpiresAt,
		IssuedAtUnix:       contact.Payload.IssuedAt,
		LastObservedUnix:   nowUnix,
		Source:             boundedIdentityContactSource(source),
		Wrapper:            contact.Wrapper,
		SenderPublicKey:    append([]byte(nil), contact.Envelope.Sender.PublicKey...),
		ProtocolVersions:   append([]string(nil), contact.Payload.ProtocolVersions...),
		ProfileMultihashes: append([]string(nil), contact.Payload.ProfileMultihashes...),
		RouteHints:         append([]protocolv0.IdentityContactRouteHint(nil), contact.Payload.RouteHints...),
	}
	cache.entries[branchID] = observation
	cloned := cloneIdentityContactObservation(observation)
	return IdentityContactCacheResult{
		Accepted:    true,
		Reason:      protocolv0.IdentityContactAccepted,
		Observation: &cloned,
	}
}

// Lookup returns the current non-expired observation for an exact BranchID.
func (cache *IdentityContactCache) Lookup(branchID string) (IdentityContactObservation, bool) {
	cache.mu.Lock()
	defer cache.mu.Unlock()

	if err := protocolv0.ParseBranchID(branchID); err != nil {
		return IdentityContactObservation{}, false
	}
	nowUnix := cache.now().Unix()
	cache.pruneExpiredLocked(nowUnix)
	observation, ok := cache.entries[branchID]
	if !ok {
		return IdentityContactObservation{}, false
	}
	return cloneIdentityContactObservation(observation), true
}

// Snapshot returns a bounded stable-order copy for operator diagnostics.
func (cache *IdentityContactCache) Snapshot(limit int) []IdentityContactObservation {
	cache.mu.Lock()
	defer cache.mu.Unlock()

	cache.pruneExpiredLocked(cache.now().Unix())
	observations := make([]IdentityContactObservation, 0, len(cache.entries))
	for _, observation := range cache.entries {
		observations = append(observations, cloneIdentityContactObservation(observation))
	}
	sort.Slice(observations, func(left, right int) bool {
		if observations[left].LastObservedUnix != observations[right].LastObservedUnix {
			return observations[left].LastObservedUnix > observations[right].LastObservedUnix
		}
		return observations[left].BranchID < observations[right].BranchID
	})
	if limit > 0 && len(observations) > limit {
		return observations[:limit]
	}
	return observations
}

func (cache *IdentityContactCache) pruneExpiredLocked(nowUnix int64) {
	for branchID, observation := range cache.entries {
		if observation.ExpiresAtUnix <= nowUnix {
			delete(cache.entries, branchID)
		}
	}
}

func (cache *IdentityContactCache) evictOldestLocked() {
	var oldestBranchID string
	var oldestObserved int64
	for branchID, observation := range cache.entries {
		if oldestBranchID == "" || observation.LastObservedUnix < oldestObserved {
			oldestBranchID = branchID
			oldestObserved = observation.LastObservedUnix
		}
	}
	if oldestBranchID != "" {
		delete(cache.entries, oldestBranchID)
	}
}

func boundedIdentityContactSource(source string) string {
	source = strings.TrimSpace(source)
	if len([]byte(source)) <= maxIdentityContactSourceBytes {
		return source
	}
	bytes := []byte(source)
	return string(bytes[:maxIdentityContactSourceBytes])
}

func cloneIdentityContactObservation(observation IdentityContactObservation) IdentityContactObservation {
	return IdentityContactObservation{
		BranchID:           observation.BranchID,
		Sequence:           observation.Sequence,
		ExpiresAtUnix:      observation.ExpiresAtUnix,
		IssuedAtUnix:       observation.IssuedAtUnix,
		LastObservedUnix:   observation.LastObservedUnix,
		Source:             observation.Source,
		Wrapper:            observation.Wrapper,
		SenderPublicKey:    append([]byte(nil), observation.SenderPublicKey...),
		ProtocolVersions:   append([]string(nil), observation.ProtocolVersions...),
		ProfileMultihashes: append([]string(nil), observation.ProfileMultihashes...),
		RouteHints:         append([]protocolv0.IdentityContactRouteHint(nil), observation.RouteHints...),
	}
}
