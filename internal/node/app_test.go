package node

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/code4bones/branch/internal/admin"
	"github.com/code4bones/branch/internal/relay"
	"github.com/code4bones/branch/internal/relay/wss"
	protocol "github.com/code4bones/branch/protocol/v0"
)

func TestNewComposesPublicRelayAndProtectedAdminSurfaces(t *testing.T) {
	app := newTestApp(t)

	publicResponse := httptest.NewRecorder()
	app.PublicHandler().ServeHTTP(publicResponse, httptest.NewRequest(http.MethodGet, "/unknown", nil))
	if publicResponse.Code != http.StatusNotFound {
		t.Fatalf("public unknown status = %d", publicResponse.Code)
	}

	adminRequest := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	adminResponse := httptest.NewRecorder()
	app.AdminHandler().ServeHTTP(adminResponse, adminRequest)
	if adminResponse.Code != http.StatusForbidden {
		t.Fatalf("admin without token status = %d", adminResponse.Code)
	}

	adminRequest = httptest.NewRequest(http.MethodGet, "/readyz", nil)
	adminRequest.Header.Set("authorization", "Bearer test-token")
	adminResponse = httptest.NewRecorder()
	app.AdminHandler().ServeHTTP(adminResponse, adminRequest)
	if adminResponse.Code != http.StatusOK {
		t.Fatalf("admin ready status = %d", adminResponse.Code)
	}

	var snapshot admin.StatusSnapshot
	if err := json.Unmarshal(adminResponse.Body.Bytes(), &snapshot); err != nil {
		t.Fatalf("decode admin snapshot: %v", err)
	}
	if snapshot.ServiceName != "branch-node" || snapshot.Readiness != admin.ReadinessReady {
		t.Fatalf("unexpected admin snapshot: %+v", snapshot)
	}
	if len(snapshot.ProtocolVersions) != 1 || len(snapshot.Capabilities) != 2 {
		t.Fatalf("snapshot missing protocol/capabilities: %+v", snapshot)
	}

	diagnosticsRequest := httptest.NewRequest(http.MethodGet, "/diagnostics", nil)
	diagnosticsRequest.Header.Set("authorization", "Bearer test-token")
	diagnosticsResponse := httptest.NewRecorder()
	app.AdminHandler().ServeHTTP(diagnosticsResponse, diagnosticsRequest)
	if diagnosticsResponse.Code != http.StatusOK {
		t.Fatalf("diagnostics status = %d", diagnosticsResponse.Code)
	}
	for _, forbidden := range []string{"peer_id", "session_id", "public_key", "ciphertext"} {
		if strings.Contains(adminResponse.Body.String(), forbidden) {
			t.Fatalf("admin snapshot leaked %q: %s", forbidden, adminResponse.Body.String())
		}
	}
}

func TestNewRejectsMissingIdentityPath(t *testing.T) {
	config := DefaultConfig()
	config.IdentityPath = ""
	if _, err := New(config); err == nil {
		t.Fatal("expected missing identity path error")
	}
}

func TestNewLeavesGitHubIdentityCarrierDisabledByDefault(t *testing.T) {
	app := newTestApp(t)
	publicKey, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate identity key: %v", err)
	}
	branchID, err := protocol.BranchIDFromPublicKey(publicKey)
	if err != nil {
		t.Fatalf("branch id: %v", err)
	}
	result := app.identityLookup.Lookup(context.Background(), branchID)
	if len(result.Trace) != 2 || result.Trace[0].Source != "local_cache" || result.Trace[1].Source != "relay_mesh" {
		t.Fatalf("default identity lookup trace = %+v", result.Trace)
	}
}

func TestRelayCapabilitiesExposeEnabledFederationDiscovery(t *testing.T) {
	if capabilities := relayCapabilities(false); slices.Contains(capabilities, protocol.RelayFederationLiveRole) {
		t.Fatalf("disabled federation advertised: %v", capabilities)
	}
	if capabilities := relayCapabilities(true); !slices.Contains(capabilities, protocol.RelayFederationLiveRole) {
		t.Fatalf("enabled federation omitted: %v", capabilities)
	}
}

func newTestApp(t *testing.T) *App {
	t.Helper()
	config := DefaultConfig()
	config.PublicAddr = "127.0.0.1:0"
	config.AdminAddr = "127.0.0.1:0"
	config.IdentityPath = filepath.Join(t.TempDir(), "node-identity.json")
	config.AdminToken = "test-token"
	config.Relay = relay.Config{
		MaxSessions:         4,
		MaxQueueDepth:       4,
		MaxFrameBytes:       49_152,
		MaxFramesPerSession: 16,
		MaxBytesPerSession:  1 << 20,
		PresenceTTL:         30 * time.Second,
	}

	app, err := New(config)
	if err != nil {
		t.Fatalf("new app: %v", err)
	}
	if app.PublicHandler() == nil || app.AdminHandler() == nil || app.Hub() == nil {
		t.Fatalf("app missing composed surfaces")
	}
	t.Cleanup(app.closeObservability)
	publicMux := app.PublicHandler()
	request := httptest.NewRequest(http.MethodGet, wss.Path, nil)
	response := httptest.NewRecorder()
	publicMux.ServeHTTP(response, request)
	if response.Code < 400 {
		t.Fatalf("non-upgrade relay status = %d", response.Code)
	}
	return app
}
