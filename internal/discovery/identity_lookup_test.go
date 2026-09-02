package discovery

import (
	"context"
	"crypto/ed25519"
	"testing"
	"time"

	protocolv0 "github.com/code4bones/branch/protocol/v0"
)

func TestIdentityContactLookupReturnsLocalCacheHitWithoutFanout(t *testing.T) {
	now := time.Date(2026, 9, 2, 14, 0, 0, 0, time.UTC)
	cache := newTestIdentityContactCache(t, now, 8)
	publicKey, privateKey := testIdentityKey(t)
	branchID := testBranchID(t, publicKey)
	wrapper := createCacheIdentityContact(t, cacheContactOptions{
		now:        now.Unix(),
		expires:    now.Add(time.Hour).Unix(),
		sequence:   1,
		publicKey:  publicKey,
		privateKey: privateKey,
	})
	if result := cache.Accept(wrapper, "github", protocolv0.IdentityContactValidationOptions{}); !result.Accepted {
		t.Fatalf("cache accept = %+v", result)
	}
	source := &staticIdentityContactLookupSource{id: "peer-relay", t: t}
	lookup := newTestIdentityContactLookup(t, cache, now, source)

	result := lookup.Lookup(context.Background(), branchID)
	if result.Observation == nil || result.Observation.BranchID != branchID {
		t.Fatalf("lookup result = %+v", result)
	}
	if source.calls != 0 {
		t.Fatalf("source calls = %d", source.calls)
	}
	if len(result.Trace) != 1 || result.Trace[0].Source != "local_cache" || !result.Trace[0].Accepted {
		t.Fatalf("trace = %+v", result.Trace)
	}
}

func TestIdentityContactLookupAcceptsExactSourceCandidate(t *testing.T) {
	now := time.Date(2026, 9, 2, 14, 0, 0, 0, time.UTC)
	cache := newTestIdentityContactCache(t, now, 8)
	publicKey, privateKey := testIdentityKey(t)
	branchID := testBranchID(t, publicKey)
	wrapper := createCacheIdentityContact(t, cacheContactOptions{
		now:        now.Unix(),
		expires:    now.Add(time.Hour).Unix(),
		sequence:   3,
		publicKey:  publicKey,
		privateKey: privateKey,
	})
	lookup := newTestIdentityContactLookup(t, cache, now, &staticIdentityContactLookupSource{
		id: "peer-relay",
		t:  t,
		candidates: []IdentityContactCandidate{{
			Wrapper: wrapper,
			Source:  "have",
		}},
	})

	result := lookup.Lookup(context.Background(), branchID)
	if result.Observation == nil || result.Observation.BranchID != branchID || result.Observation.Sequence != 3 {
		t.Fatalf("lookup result = %+v", result)
	}
	if len(result.Trace) != 2 || result.Trace[1].Reason != string(protocolv0.IdentityContactAccepted) {
		t.Fatalf("trace = %+v", result.Trace)
	}
}

func TestIdentityContactLookupRejectsMismatchedBranchCandidate(t *testing.T) {
	now := time.Date(2026, 9, 2, 14, 0, 0, 0, time.UTC)
	cache := newTestIdentityContactCache(t, now, 8)
	targetPublicKey, _ := testIdentityKey(t)
	branchID := testBranchID(t, targetPublicKey)
	otherPublicKey, otherPrivateKey := testIdentityKey(t)
	wrapper := createCacheIdentityContact(t, cacheContactOptions{
		now:        now.Unix(),
		expires:    now.Add(time.Hour).Unix(),
		sequence:   1,
		publicKey:  otherPublicKey,
		privateKey: otherPrivateKey,
	})
	lookup := newTestIdentityContactLookup(t, cache, now, &staticIdentityContactLookupSource{
		id: "peer-relay",
		t:  t,
		candidates: []IdentityContactCandidate{{
			Wrapper: wrapper,
		}},
	})

	result := lookup.Lookup(context.Background(), branchID)
	if result.Observation != nil {
		t.Fatalf("unexpected observation = %+v", result.Observation)
	}
	if _, ok := cache.Lookup(branchID); ok {
		t.Fatal("mismatched candidate stored under requested branch id")
	}
}

func TestIdentityContactLookupBoundsCandidateFanout(t *testing.T) {
	now := time.Date(2026, 9, 2, 14, 0, 0, 0, time.UTC)
	cache := newTestIdentityContactCache(t, now, 8)
	targetPublicKey, _ := testIdentityKey(t)
	branchID := testBranchID(t, targetPublicKey)
	candidates := make([]IdentityContactCandidate, 0, 3)
	for range 3 {
		publicKey, privateKey := testIdentityKey(t)
		candidates = append(candidates, IdentityContactCandidate{
			Wrapper: createCacheIdentityContact(t, cacheContactOptions{
				now:        now.Unix(),
				expires:    now.Add(time.Hour).Unix(),
				sequence:   1,
				publicKey:  publicKey,
				privateKey: privateKey,
			}),
		})
	}
	lookup, err := NewIdentityContactLookup(IdentityContactLookupConfig{
		Cache:         cache,
		Sources:       []IdentityContactLookupSource{&staticIdentityContactLookupSource{id: "peer-relay", t: t, candidates: candidates}},
		Now:           func() time.Time { return now },
		MaxCandidates: 2,
	})
	if err != nil {
		t.Fatalf("lookup: %v", err)
	}

	result := lookup.Lookup(context.Background(), branchID)
	if result.Observation != nil {
		t.Fatalf("unexpected observation = %+v", result.Observation)
	}
	if result.Trace[len(result.Trace)-1].Reason != "candidate_limit" {
		t.Fatalf("trace = %+v", result.Trace)
	}
}

type staticIdentityContactLookupSource struct {
	id         string
	t          *testing.T
	candidates []IdentityContactCandidate
	err        error
	calls      int
}

func (source *staticIdentityContactLookupSource) ID() string {
	return source.id
}

func (source *staticIdentityContactLookupSource) LookupIdentityContact(ctx context.Context, branchID string) ([]IdentityContactCandidate, error) {
	source.t.Helper()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if branchID == "" {
		source.t.Fatal("empty branch id")
	}
	source.calls++
	if source.err != nil {
		return nil, source.err
	}
	return source.candidates, nil
}

func testBranchID(t *testing.T, publicKey ed25519.PublicKey) string {
	t.Helper()
	branchID, err := protocolv0.BranchIDFromPublicKey(publicKey)
	if err != nil {
		t.Fatalf("branch id: %v", err)
	}
	return branchID
}

func TestIdentityContactLookupRejectsInvalidConfig(t *testing.T) {
	if _, err := NewIdentityContactLookup(IdentityContactLookupConfig{}); err != ErrInvalidIdentityLookupConfig {
		t.Fatalf("error = %v", err)
	}
	cache := newTestIdentityContactCache(t, time.Now(), 8)
	if _, err := NewIdentityContactLookup(IdentityContactLookupConfig{
		Cache:      cache,
		MaxSources: 1,
		Sources: []IdentityContactLookupSource{
			&staticIdentityContactLookupSource{id: "one", t: t},
			&staticIdentityContactLookupSource{id: "two", t: t},
		},
	}); err != ErrInvalidIdentityLookupConfig {
		t.Fatalf("error = %v", err)
	}
}

func TestIdentityContactLookupRejectsInvalidBranchID(t *testing.T) {
	cache := newTestIdentityContactCache(t, time.Now(), 8)
	lookup := newTestIdentityContactLookup(t, cache, time.Now())

	result := lookup.Lookup(context.Background(), "bad")
	if result.Observation != nil || len(result.Trace) != 1 || result.Trace[0].Reason != "invalid_branch_id" {
		t.Fatalf("result = %+v", result)
	}
}

func newTestIdentityContactLookup(t *testing.T, cache *IdentityContactCache, now time.Time, sources ...IdentityContactLookupSource) *IdentityContactLookup {
	t.Helper()
	lookup, err := NewIdentityContactLookup(IdentityContactLookupConfig{
		Cache:   cache,
		Sources: sources,
		Now: func() time.Time {
			return now
		},
	})
	if err != nil {
		t.Fatalf("lookup: %v", err)
	}
	return lookup
}
