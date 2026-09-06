package github

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/code4bones/branch/internal/discovery"
	protocol "github.com/code4bones/branch/protocol/v0"
)

func TestIdentityContactSourceReturnsBoundedExactCandidates(t *testing.T) {
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	branchID, wrapper := testIdentityContact(t, now, now.Add(time.Hour))
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests++
		switch request.URL.Path {
		case "/search/repositories":
			if got := request.URL.Query().Get("q"); got != "topic:branchbootstrapv0" {
				t.Fatalf("search query = %q", got)
			}
			if got := request.URL.Query().Get("per_page"); got != "2" {
				t.Fatalf("per page = %q", got)
			}
			_, _ = response.Write([]byte(`{"items":[{"full_name":"owner/repo","fork":false,"default_branch":"main","owner":{"login":"owner"},"name":"repo"},{"full_name":"owner/fork","fork":true,"default_branch":"main","owner":{"login":"owner"},"name":"fork"}]}`))
		case "/repos/owner/repo/contents/.branch/records.br0":
			if got := request.URL.Query().Get("ref"); got != "main" {
				t.Fatalf("record ref = %q", got)
			}
			content := base64.StdEncoding.EncodeToString([]byte("# carrier comment\n" + wrapper + "\nBRANCH0.bad\n"))
			_, _ = fmt.Fprintf(response, `{"type":"file","encoding":"base64","content":%q}`, content)
		default:
			t.Fatalf("unexpected path %q", request.URL.Path)
		}
	}))
	defer server.Close()

	source, err := NewIdentityContactSource(IdentityContactSourceConfig{
		APIBaseURL:      server.URL,
		HTTPClient:      server.Client(),
		MaxRepositories: 2,
	})
	if err != nil {
		t.Fatalf("new source: %v", err)
	}
	candidates, err := source.LookupIdentityContact(context.Background(), branchID)
	if err != nil {
		t.Fatalf("lookup: %v", err)
	}
	if requests != 2 {
		t.Fatalf("requests = %d, want 2", requests)
	}
	if len(candidates) != 2 || candidates[0].Wrapper != wrapper || candidates[0].Source != "owner/repo/.branch/records.br0" {
		t.Fatalf("candidates = %+v", candidates)
	}
}

func TestIdentityContactSourceLookupRejectsTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		time.Sleep(100 * time.Millisecond)
	}))
	defer server.Close()
	publicKey, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	branchID, err := protocol.BranchIDFromPublicKey(publicKey)
	if err != nil {
		t.Fatalf("branch id: %v", err)
	}
	source, err := NewIdentityContactSource(IdentityContactSourceConfig{
		APIBaseURL: server.URL,
		HTTPClient: server.Client(),
		Timeout:    10 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("new source: %v", err)
	}
	if _, err := source.LookupIdentityContact(context.Background(), branchID); err == nil {
		t.Fatal("timeout lookup succeeded")
	}
}

func TestIdentityContactSourceSkipsFailedRecordsReadWhenLaterRepositoryIsValid(t *testing.T) {
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	branchID, wrapper := testIdentityContact(t, now, now.Add(time.Hour))
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/search/repositories":
			_, _ = response.Write([]byte(`{"items":[{"full_name":"owner/bad","fork":false,"default_branch":"main","owner":{"login":"owner"},"name":"bad"},{"full_name":"owner/good","fork":false,"default_branch":"main","owner":{"login":"owner"},"name":"good"}]}`))
		case "/repos/owner/bad/contents/.branch/records.br0":
			_, _ = response.Write([]byte(`{"type":"file","encoding":"base64","content":"%%%"}`))
		case "/repos/owner/good/contents/.branch/records.br0":
			content := base64.StdEncoding.EncodeToString([]byte(wrapper + "\n"))
			_, _ = fmt.Fprintf(response, `{"type":"file","encoding":"base64","content":%q}`, content)
		default:
			t.Fatalf("unexpected path %q", request.URL.Path)
		}
	}))
	defer server.Close()

	source, err := NewIdentityContactSource(IdentityContactSourceConfig{
		APIBaseURL:      server.URL,
		HTTPClient:      server.Client(),
		MaxRepositories: 2,
	})
	if err != nil {
		t.Fatalf("new source: %v", err)
	}
	candidates, err := source.LookupIdentityContact(context.Background(), branchID)
	if err != nil {
		t.Fatalf("lookup: %v", err)
	}
	if len(candidates) != 1 || candidates[0].Wrapper != wrapper || candidates[0].Source != "owner/good/.branch/records.br0" {
		t.Fatalf("candidates = %+v", candidates)
	}
}

func TestIdentityContactSourceReturnsErrorWhenEveryRecordsReadFails(t *testing.T) {
	publicKey, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	branchID, err := protocol.BranchIDFromPublicKey(publicKey)
	if err != nil {
		t.Fatalf("branch id: %v", err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/search/repositories":
			_, _ = response.Write([]byte(`{"items":[{"full_name":"owner/bad","fork":false,"default_branch":"main","owner":{"login":"owner"},"name":"bad"}]}`))
		case "/repos/owner/bad/contents/.branch/records.br0":
			_, _ = response.Write([]byte(`{"type":"file","encoding":"base64","content":"%%%"}`))
		default:
			t.Fatalf("unexpected path %q", request.URL.Path)
		}
	}))
	defer server.Close()

	source, err := NewIdentityContactSource(IdentityContactSourceConfig{APIBaseURL: server.URL, HTTPClient: server.Client()})
	if err != nil {
		t.Fatalf("new source: %v", err)
	}
	if _, err := source.LookupIdentityContact(context.Background(), branchID); err == nil {
		t.Fatal("failed records response produced an empty lookup")
	}
}

func TestIdentityContactSourcePoisonedAndExpiredCandidatesNeverEnterCache(t *testing.T) {
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	branchID, expired := testIdentityContact(t, now.Add(-time.Hour), now.Add(-time.Second))
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/search/repositories":
			_, _ = response.Write([]byte(`{"items":[{"full_name":"owner/repo","fork":false,"default_branch":"main","owner":{"login":"owner"},"name":"repo"}]}`))
		case "/repos/owner/repo/contents/.branch/records.br0":
			content := base64.StdEncoding.EncodeToString([]byte("BRANCH0.!\n" + expired + "\n"))
			_, _ = fmt.Fprintf(response, `{"type":"file","encoding":"base64","content":%q}`, content)
		default:
			t.Fatalf("unexpected path %q", request.URL.Path)
		}
	}))
	defer server.Close()
	source, err := NewIdentityContactSource(IdentityContactSourceConfig{APIBaseURL: server.URL, HTTPClient: server.Client()})
	if err != nil {
		t.Fatalf("new source: %v", err)
	}
	cache, err := discovery.NewIdentityContactCache(discovery.IdentityContactCacheConfig{Now: func() time.Time { return now }})
	if err != nil {
		t.Fatalf("new cache: %v", err)
	}
	lookup, err := discovery.NewIdentityContactLookup(discovery.IdentityContactLookupConfig{
		Cache:   cache,
		Sources: []discovery.IdentityContactLookupSource{source},
		Now:     func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("new lookup: %v", err)
	}
	result := lookup.Lookup(context.Background(), branchID)
	if result.Observation != nil {
		t.Fatalf("poisoned lookup accepted %+v", result.Observation)
	}
	if _, ok := cache.Lookup(branchID); ok {
		t.Fatal("poisoned or expired record entered cache")
	}
	if len(result.Trace) != 3 || result.Trace[1].Reason != string(protocol.IdentityContactInvalidBase64URL) || result.Trace[2].Reason != string(protocol.IdentityContactExpired) {
		t.Fatalf("trace = %+v", result.Trace)
	}
}

func TestIdentityContactSourceRejectsMalformedSearchResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		_, _ = response.Write([]byte(`{"items":`))
	}))
	defer server.Close()
	publicKey, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	branchID, err := protocol.BranchIDFromPublicKey(publicKey)
	if err != nil {
		t.Fatalf("branch id: %v", err)
	}
	source, err := NewIdentityContactSource(IdentityContactSourceConfig{APIBaseURL: server.URL, HTTPClient: server.Client()})
	if err != nil {
		t.Fatalf("new source: %v", err)
	}
	if _, err := source.LookupIdentityContact(context.Background(), branchID); err == nil {
		t.Fatal("malformed search response accepted")
	}
}

func testIdentityContact(t *testing.T, now time.Time, expiresAt time.Time) (string, string) {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate identity key: %v", err)
	}
	branchID, err := protocol.BranchIDFromPublicKey(publicKey)
	if err != nil {
		t.Fatalf("branch id: %v", err)
	}
	relayPublicKey := make([]byte, ed25519.PublicKeySize)
	if _, err := rand.Read(relayPublicKey); err != nil {
		t.Fatalf("random relay key: %v", err)
	}
	wrapper, err := protocol.CreateIdentityContactWrapper(protocol.IdentityContactOptions{
		NowUnix:            now.Unix(),
		ExpiresAtUnix:      expiresAt.Unix(),
		Sequence:           1,
		ContactID:          bytesOf(1, 32),
		EventID:            bytesOf(2, 32),
		SenderPublicKey:    publicKey,
		Aliases:            []string{},
		ProtocolVersions:   []string{protocol.ProtocolID},
		ProfileMultihashes: []string{protocol.DevelopmentProfileMultihash},
		RouteHints: []protocol.IdentityContactRouteHint{{
			Transport:        "wss",
			URI:              "wss://relay.example.test:443/relay/v0",
			RelayPublicKey:   base64.RawURLEncoding.EncodeToString(relayPublicKey),
			ProfileMultihash: protocol.DevelopmentProfileMultihash,
			Priority:         0,
		}},
		Sign: func(input []byte) ([]byte, error) {
			return ed25519.Sign(privateKey, input), nil
		},
	})
	if err != nil {
		t.Fatalf("create identity contact: %v", err)
	}
	return branchID, wrapper
}

func bytesOf(value byte, length int) []byte {
	return bytes.Repeat([]byte{value}, length)
}
