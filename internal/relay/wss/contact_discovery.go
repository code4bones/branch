package wss

import (
	"sync"
	"time"

	"github.com/code4bones/branch/internal/relay"
)

const contactDiscoveryWindow = time.Minute

// contactDiscovery is process-local live routing metadata. It deliberately has
// no storage adapter, queue, result cache, or negative-result representation.
type contactDiscovery struct {
	mu        sync.Mutex
	byBranch  map[string]contactTargets
	bySession map[relay.SessionID]string
	lookups   map[relay.SessionID]contactRequestWindow
	probes    map[relay.SessionID][]time.Time
}

type contactTarget struct {
	sessionID relay.SessionID
	peerID    relay.PeerID
	conn      *connection
}

// contactTargets holds all concurrently live opted-in sessions for one exact
// BranchID. selected preserves the former most-recent-announce preference
// while every target remains removable only by its own session lifecycle.
type contactTargets struct {
	bySession map[relay.SessionID]contactTarget
	selected  relay.SessionID
}

// contactRequestWindow maps a request ID to the relay-observed arrival time.
// Client expiry bounds the probe's usefulness, but must not let a requester
// shorten the relay's rolling anti-enumeration window.
type contactRequestWindow struct{ entries map[string]time.Time }

func newContactDiscovery() contactDiscovery {
	return contactDiscovery{byBranch: make(map[string]contactTargets), bySession: make(map[relay.SessionID]string), lookups: make(map[relay.SessionID]contactRequestWindow), probes: make(map[relay.SessionID][]time.Time)}
}

func (state *contactDiscovery) announce(sessionID relay.SessionID, branchID string, peerID relay.PeerID, conn *connection, discoverable bool) {
	state.mu.Lock()
	defer state.mu.Unlock()
	state.removeLocked(sessionID)
	if discoverable {
		targets := state.byBranch[branchID]
		if targets.bySession == nil {
			targets.bySession = make(map[relay.SessionID]contactTarget)
		}
		targets.bySession[sessionID] = contactTarget{sessionID: sessionID, peerID: peerID, conn: conn}
		targets.selected = sessionID
		state.byBranch[branchID] = targets
		state.bySession[sessionID] = branchID
	}
}

func (state *contactDiscovery) remove(sessionID relay.SessionID) {
	state.mu.Lock()
	defer state.mu.Unlock()
	state.removeLocked(sessionID)
}
func (state *contactDiscovery) removeLocked(sessionID relay.SessionID) {
	if branchID, ok := state.bySession[sessionID]; ok {
		targets := state.byBranch[branchID]
		delete(targets.bySession, sessionID)
		if len(targets.bySession) == 0 {
			delete(state.byBranch, branchID)
		} else {
			if targets.selected == sessionID {
				for replacement := range targets.bySession {
					targets.selected = replacement
					break
				}
			}
			state.byBranch[branchID] = targets
		}
		delete(state.bySession, sessionID)
	}
	delete(state.lookups, sessionID)
	delete(state.probes, sessionID)
}

// reserve returns a target exactly once only when requester replay/rate and
// target probe limits are live-valid. Requester accounting is based solely on
// relay-observed arrival time; all state expires with the connection.
func (state *contactDiscovery) reserve(requester relay.SessionID, requestID, branchID string, now time.Time, _ time.Time) (contactTarget, bool) {
	state.mu.Lock()
	defer state.mu.Unlock()
	window := state.lookups[requester]
	if window.entries == nil {
		window.entries = make(map[string]time.Time, 4)
	}
	cutoff := now.Add(-contactDiscoveryWindow)
	for id, observedAt := range window.entries {
		if !observedAt.After(cutoff) {
			delete(window.entries, id)
		}
	}
	if len(window.entries) >= 4 {
		return contactTarget{}, false
	}
	if _, duplicate := window.entries[requestID]; duplicate {
		return contactTarget{}, false
	}
	targets, ok := state.byBranch[branchID]
	if !ok {
		return contactTarget{}, false
	}
	target, ok := targets.bySession[targets.selected]
	if !ok {
		return contactTarget{}, false
	}
	probes := state.probes[target.sessionID]
	probeCutoff := now.Add(-contactDiscoveryWindow)
	kept := probes[:0]
	for _, at := range probes {
		if at.After(probeCutoff) {
			kept = append(kept, at)
		}
	}
	if len(kept) >= 4 {
		state.probes[target.sessionID] = kept
		return contactTarget{}, false
	}
	window.entries[requestID] = now
	state.lookups[requester] = window
	state.probes[target.sessionID] = append(kept, now)
	return target, true
}
