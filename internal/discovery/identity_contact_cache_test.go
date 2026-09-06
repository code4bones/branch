package discovery

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"strings"
	"testing"
	"time"

	protocolv0 "github.com/code4bones/branch/protocol/v0"
)

func TestIdentityContactCacheAcceptsAndLooksUpSignedRecord(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	cache := newTestIdentityContactCache(t, now, 8)
	publicKey, privateKey := testIdentityKey(t)
	wrapper := createCacheIdentityContact(t, cacheContactOptions{
		now:        now.Unix(),
		expires:    now.Add(time.Hour).Unix(),
		sequence:   4,
		publicKey:  publicKey,
		privateKey: privateKey,
	})
	branchID, err := protocolv0.BranchIDFromPublicKey(publicKey)
	if err != nil {
		t.Fatalf("branch id: %v", err)
	}

	result := cache.Accept(wrapper, "github:code4bones/br_test01/.branch/records.br0", protocolv0.IdentityContactValidationOptions{})
	if !result.Accepted || result.Reason != protocolv0.IdentityContactAccepted {
		t.Fatalf("accept result = %+v", result)
	}
	if result.Observation == nil || result.Observation.BranchID != branchID {
		t.Fatalf("observation = %+v", result.Observation)
	}

	observation, ok := cache.Lookup(branchID)
	if !ok {
		t.Fatal("lookup failed")
	}
	if observation.Sequence != 4 || observation.Wrapper != wrapper {
		t.Fatalf("observation = %+v", observation)
	}
}

func TestIdentityContactCacheRejectsInvalidAndLowerSequenceRecords(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	cache := newTestIdentityContactCache(t, now, 8)
	publicKey, privateKey := testIdentityKey(t)
	high := createCacheIdentityContact(t, cacheContactOptions{
		now:        now.Unix(),
		expires:    now.Add(time.Hour).Unix(),
		sequence:   8,
		publicKey:  publicKey,
		privateKey: privateKey,
	})
	low := createCacheIdentityContact(t, cacheContactOptions{
		now:        now.Unix(),
		expires:    now.Add(time.Hour).Unix(),
		sequence:   7,
		publicKey:  publicKey,
		privateKey: privateKey,
	})
	if result := cache.Accept(high, "carrier-a", protocolv0.IdentityContactValidationOptions{}); !result.Accepted {
		t.Fatalf("accept high = %+v", result)
	}
	result := cache.Accept(low, "carrier-b", protocolv0.IdentityContactValidationOptions{})
	if result.Accepted || result.Reason != protocolv0.IdentityContactLowerSequence {
		t.Fatalf("accept low = %+v", result)
	}

	tampered := high[:len(high)-1] + "!"
	result = cache.Accept(tampered, "carrier-c", protocolv0.IdentityContactValidationOptions{})
	if result.Accepted || result.Reason != protocolv0.IdentityContactInvalidBase64URL {
		t.Fatalf("accept tampered = %+v", result)
	}
}

func TestIdentityContactCacheRejectsDistinctEqualSequenceRecords(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	cache := newTestIdentityContactCache(t, now, 8)
	publicKey, privateKey := testIdentityKey(t)
	first := createCacheIdentityContact(t, cacheContactOptions{
		now:        now.Unix(),
		expires:    now.Add(time.Hour).Unix(),
		sequence:   8,
		publicKey:  publicKey,
		privateKey: privateKey,
	})
	second := createCacheIdentityContact(t, cacheContactOptions{
		now:        now.Unix(),
		expires:    now.Add(time.Hour).Unix(),
		sequence:   8,
		publicKey:  publicKey,
		privateKey: privateKey,
	})
	if first == second {
		t.Fatal("distinct records unexpectedly matched")
	}
	if result := cache.Accept(first, "carrier-a", protocolv0.IdentityContactValidationOptions{}); !result.Accepted {
		t.Fatalf("accept first = %+v", result)
	}
	if result := cache.Accept(second, "carrier-b", protocolv0.IdentityContactValidationOptions{}); result.Accepted || result.Reason != protocolv0.IdentityContactEquivocation {
		t.Fatalf("accept conflicting record = %+v", result)
	}
	if result := cache.Accept(first, "carrier-c", protocolv0.IdentityContactValidationOptions{}); !result.Accepted || result.Observation == nil || result.Observation.Wrapper != first {
		t.Fatalf("accept exact duplicate = %+v", result)
	}

	branchID, err := protocolv0.BranchIDFromPublicKey(publicKey)
	if err != nil {
		t.Fatalf("branch id: %v", err)
	}
	observation, ok := cache.Lookup(branchID)
	if !ok || observation.Wrapper != first {
		t.Fatalf("cache retained conflicted record: %+v, %t", observation, ok)
	}
}

func TestIdentityContactCacheForgetsExpiredAndRestartedObservations(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	current := now
	cache, err := NewIdentityContactCache(IdentityContactCacheConfig{
		MaxEntries: 4,
		Now: func() time.Time {
			return current
		},
	})
	if err != nil {
		t.Fatalf("cache: %v", err)
	}
	publicKey, privateKey := testIdentityKey(t)
	wrapper := createCacheIdentityContact(t, cacheContactOptions{
		now:        now.Unix(),
		expires:    now.Add(time.Hour).Unix(),
		sequence:   1,
		publicKey:  publicKey,
		privateKey: privateKey,
	})
	branchID, err := protocolv0.BranchIDFromPublicKey(publicKey)
	if err != nil {
		t.Fatalf("branch id: %v", err)
	}
	if result := cache.Accept(wrapper, "carrier-a", protocolv0.IdentityContactValidationOptions{}); !result.Accepted {
		t.Fatalf("accept = %+v", result)
	}

	current = now.Add(2 * time.Hour)
	if _, ok := cache.Lookup(branchID); ok {
		t.Fatal("expired observation survived lookup")
	}

	restarted := newTestIdentityContactCache(t, now, 4)
	if _, ok := restarted.Lookup(branchID); ok {
		t.Fatal("fresh cache restored observation")
	}
}

func TestIdentityContactCacheStaysBounded(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	current := now
	cache, err := NewIdentityContactCache(IdentityContactCacheConfig{
		MaxEntries: 2,
		Now: func() time.Time {
			return current
		},
	})
	if err != nil {
		t.Fatalf("cache: %v", err)
	}
	branchIDs := make([]string, 0, 3)
	for index := 0; index < 3; index++ {
		publicKey, privateKey := testIdentityKey(t)
		branchID, err := protocolv0.BranchIDFromPublicKey(publicKey)
		if err != nil {
			t.Fatalf("branch id: %v", err)
		}
		branchIDs = append(branchIDs, branchID)
		wrapper := createCacheIdentityContact(t, cacheContactOptions{
			now:        now.Unix(),
			expires:    now.Add(time.Hour).Unix(),
			sequence:   1,
			publicKey:  publicKey,
			privateKey: privateKey,
		})
		current = current.Add(time.Second)
		if result := cache.Accept(wrapper, "carrier", protocolv0.IdentityContactValidationOptions{}); !result.Accepted {
			t.Fatalf("accept %d = %+v", index, result)
		}
	}

	snapshot := cache.Snapshot(0)
	if len(snapshot) != 2 {
		t.Fatalf("snapshot len = %d", len(snapshot))
	}
	if _, ok := cache.Lookup(branchIDs[0]); ok {
		t.Fatal("oldest observation was not evicted")
	}
}

type cacheContactOptions struct {
	now        int64
	expires    int64
	sequence   uint64
	publicKey  ed25519.PublicKey
	privateKey ed25519.PrivateKey
}

func newTestIdentityContactCache(t *testing.T, now time.Time, maxEntries int) *IdentityContactCache {
	t.Helper()
	cache, err := NewIdentityContactCache(IdentityContactCacheConfig{
		MaxEntries: maxEntries,
		Now: func() time.Time {
			return now
		},
	})
	if err != nil {
		t.Fatalf("cache: %v", err)
	}
	return cache
}

func createCacheIdentityContact(t *testing.T, options cacheContactOptions) string {
	t.Helper()
	relayPublicKey, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate relay key: %v", err)
	}
	wrapper, err := protocolv0.CreateIdentityContactWrapper(protocolv0.IdentityContactOptions{
		NowUnix:         options.now,
		ExpiresAtUnix:   options.expires,
		Sequence:        options.sequence,
		SenderPublicKey: options.publicKey,
		Aliases:         []string{"alice"},
		RouteHints: []protocolv0.IdentityContactRouteHint{{
			Transport:        "wss",
			URI:              "wss://relay01.undoo.ru:443/relay/v0",
			RelayPublicKey:   base64.RawURLEncoding.EncodeToString(relayPublicKey),
			ProfileMultihash: protocolv0.DevelopmentProfileMultihash,
			Priority:         0,
		}},
		Sign: func(message []byte) ([]byte, error) {
			return ed25519.Sign(options.privateKey, message), nil
		},
	})
	if err != nil {
		t.Fatalf("create identity contact: %v", err)
	}
	if !strings.HasPrefix(wrapper, protocolv0.BranchTextWrapperPrefix) {
		t.Fatalf("wrapper = %q", wrapper)
	}
	return wrapper
}

func testIdentityKey(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate identity key: %v", err)
	}
	return publicKey, privateKey
}
