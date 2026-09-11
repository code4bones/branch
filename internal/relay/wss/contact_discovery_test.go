package wss

import (
	"fmt"
	"testing"
	"time"

	"github.com/code4bones/branch/internal/relay"
)

func TestContactDiscoveryIsExactBoundedAndVolatile(t *testing.T) {
	state := newContactDiscovery()
	now := time.Unix(1_700_000_000, 0)
	target := relay.SessionID("target-session")
	state.announce(target, "br1.exact", "target-peer", &connection{}, true)

	if _, ok := state.reserve("alice", "request-one", "br1.exac", now, now.Add(time.Minute)); ok {
		t.Fatal("prefix lookup became a directory match")
	}
	resolved, ok := state.reserve("alice", "request-one", "br1.exact", now, now.Add(time.Minute))
	if !ok || resolved.sessionID != target || resolved.peerID != "target-peer" {
		t.Fatalf("exact target = %+v, %v", resolved, ok)
	}
	if _, ok := state.reserve("alice", "request-one", "br1.exact", now, now.Add(time.Minute)); ok {
		t.Fatal("replayed request id forwarded")
	}
	state.remove(target)
	if _, ok := state.reserve("alice", "request-two", "br1.exact", now, now.Add(time.Minute)); ok {
		t.Fatal("removed target retained discovery mapping")
	}
}

func TestContactDiscoveryBoundsTargetProbeWindow(t *testing.T) {
	state := newContactDiscovery()
	now := time.Unix(1_700_000_000, 0)
	state.announce("target", "br1.exact", "target-peer", &connection{}, true)
	for index := 0; index < 4; index++ {
		requestID := string(rune('a' + index))
		if _, ok := state.reserve(relay.SessionID(requestID), requestID, "br1.exact", now, now.Add(time.Minute)); !ok {
			t.Fatalf("probe %d rejected", index)
		}
	}
	if _, ok := state.reserve("fifth", "fifth", "br1.exact", now, now.Add(time.Minute)); ok {
		t.Fatal("fifth target probe accepted")
	}
}

func TestContactDiscoveryRequesterWindowUsesRelayObservedArrival(t *testing.T) {
	state := newContactDiscovery()
	now := time.Unix(1_700_000_000, 0)
	for index := 0; index < 6; index++ {
		state.announce(relay.SessionID(fmt.Sprintf("target-%d", index)), fmt.Sprintf("br1.target-%d", index), "target-peer", &connection{}, true)
	}

	shortExpiry := now.Add(time.Millisecond)
	for index := 0; index < 4; index++ {
		if _, ok := state.reserve("requester", fmt.Sprintf("request-%d", index), fmt.Sprintf("br1.target-%d", index), now, shortExpiry); !ok {
			t.Fatalf("accepted lookup %d rejected", index)
		}
	}
	if _, ok := state.reserve("requester", "short-ttl-bypass", "br1.target-4", now.Add(2*time.Millisecond), now.Add(3*time.Millisecond)); ok {
		t.Fatal("short client TTL bypassed relay-observed requester window")
	}
	if _, ok := state.reserve("requester", "window-boundary", "br1.target-5", now.Add(contactDiscoveryWindow), now.Add(contactDiscoveryWindow+time.Millisecond)); !ok {
		t.Fatal("relay-observed requester window did not expire at its 60-second boundary")
	}
}

func TestContactDiscoveryRequesterDuplicateAndSessionCleanup(t *testing.T) {
	state := newContactDiscovery()
	now := time.Unix(1_700_000_000, 0)
	requester := relay.SessionID("requester")
	state.announce("target", "br1.exact", "target-peer", &connection{}, true)

	if _, ok := state.reserve(requester, "request-one", "br1.exact", now, now.Add(time.Millisecond)); !ok {
		t.Fatal("initial lookup rejected")
	}
	if _, ok := state.reserve(requester, "request-one", "br1.exact", now.Add(time.Second), now.Add(2*time.Second)); ok {
		t.Fatal("duplicate request was accepted after its client TTL but inside relay window")
	}
	state.remove(requester)
	if _, retained := state.lookups[requester]; retained {
		t.Fatal("requester lookup window survived session cleanup")
	}
	if _, ok := state.reserve(requester, "request-one", "br1.exact", now.Add(time.Second), now.Add(2*time.Second)); !ok {
		t.Fatal("session cleanup retained duplicate request state")
	}
}

func TestContactDiscoveryKeepsOtherLiveSessionForSameBranchID(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)

	t.Run("removing older session preserves newer selected target", func(t *testing.T) {
		state := newContactDiscovery()
		state.announce("older", "br1.same", "peer", &connection{}, true)
		state.announce("newer", "br1.same", "peer", &connection{}, true)

		resolved, ok := state.reserve("requester-before-cleanup", "request-before-cleanup", "br1.same", now, now.Add(time.Minute))
		if !ok || resolved.sessionID != "newer" {
			t.Fatalf("target before older cleanup = %+v, %v", resolved, ok)
		}

		state.remove("older")
		for index := 0; index < 3; index++ {
			requester := relay.SessionID(fmt.Sprintf("requester-after-cleanup-%d", index))
			requestID := fmt.Sprintf("request-after-cleanup-%d", index)
			resolved, ok := state.reserve(requester, requestID, "br1.same", now, now.Add(time.Minute))
			if !ok || resolved.sessionID != "newer" {
				t.Fatalf("target after older cleanup = %+v, %v", resolved, ok)
			}
		}
		if _, ok := state.reserve("requester-over-limit", "request-over-limit", "br1.same", now, now.Add(time.Minute)); ok {
			t.Fatal("older session cleanup reset newer target probe window")
		}

		state.remove("newer")
		if _, ok := state.reserve("requester-two", "request-two", "br1.same", now, now.Add(time.Minute)); ok {
			t.Fatal("final session cleanup retained discovery mapping")
		}
	})

	t.Run("removing newer session preserves older target", func(t *testing.T) {
		state := newContactDiscovery()
		state.announce("older", "br1.same", "peer", &connection{}, true)
		state.announce("newer", "br1.same", "peer", &connection{}, true)

		state.remove("newer")
		resolved, ok := state.reserve("requester", "request-one", "br1.same", now, now.Add(time.Minute))
		if !ok || resolved.sessionID != "older" {
			t.Fatalf("target after newer cleanup = %+v, %v", resolved, ok)
		}
	})
}
