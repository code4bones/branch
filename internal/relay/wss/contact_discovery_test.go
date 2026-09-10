package wss

import (
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
