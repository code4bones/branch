package main

import (
	"testing"

	protocol "github.com/code4bones/branch/protocol/v0"
)

func TestParseFederationPeersRequiresPinnedKeyAndProfileFields(t *testing.T) {
	const relayKey = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
	peers, err := parseFederationPeers("wss://relay.example.test:443/relay/v0|" + relayKey + "|" + protocol.DevelopmentProfileMultihash)
	if err != nil {
		t.Fatalf("parse federation peers: %v", err)
	}
	if len(peers) != 1 || peers[0].RelayPublicKey != relayKey || peers[0].ProfileMultihash != protocol.DevelopmentProfileMultihash {
		t.Fatalf("parsed peers = %+v", peers)
	}

	if _, err := parseFederationPeers("wss://relay.example.test:443/relay/v0"); err == nil {
		t.Fatal("URL-only federation peer was accepted")
	}
}
