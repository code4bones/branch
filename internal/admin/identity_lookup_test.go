package admin

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/code4bones/branch/internal/discovery"
	protocol "github.com/code4bones/branch/protocol/v0"
)

func TestHTTPHandlerServesIdentityContactLookupTrace(t *testing.T) {
	const branchID = "br1.EiAAAQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHw"
	const wrapper = "BRANCH0.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	provider := &staticIdentityLookupProvider{
		result: discovery.IdentityContactLookupResult{
			BranchID: branchID,
			Observation: &discovery.IdentityContactObservation{
				BranchID:         branchID,
				Sequence:         9,
				IssuedAtUnix:     1_789_000_000,
				ExpiresAtUnix:    1_789_003_600,
				LastObservedUnix: 1_789_000_010,
				Source:           "relay_mesh:wss://relay02.undoo.ru:443/relay/v0",
				Wrapper:          wrapper,
				ProtocolVersions: []string{protocol.ProtocolID},
				RouteHints: []protocol.IdentityContactRouteHint{{
					Transport:        "wss",
					URI:              "wss://relay02.undoo.ru:443/relay/v0",
					RelayPublicKey:   "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
					ProfileMultihash: protocol.DevelopmentProfileMultihash,
					Priority:         0,
				}},
			},
			Trace: []discovery.IdentityContactLookupTrace{{
				Source:   "local_cache",
				Step:     "lookup",
				Accepted: false,
				Reason:   "miss",
			}, {
				Source:    "relay_mesh",
				Step:      "candidate",
				Accepted:  true,
				Reason:    "accepted",
				Candidate: 1,
			}},
		},
	}
	handler := NewHTTPHandler(
		NewHandler(staticProvider{}, WithIdentityContactLookupProvider(provider)),
		AuthorizerFunc(func(request *http.Request) bool {
			return request.Header.Get("authorization") == "Bearer admin-token"
		}),
	)
	request := httptest.NewRequest(http.MethodGet, IdentityContactLookupPath+"?branch_id="+branchID, nil)
	request.Header.Set("authorization", "Bearer admin-token")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	body := response.Body.String()
	if strings.Contains(body, wrapper) {
		t.Fatalf("lookup response leaked full wrapper: %s", body)
	}
	var decoded IdentityContactLookupResponse
	if err := json.Unmarshal(response.Body.Bytes(), &decoded); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !decoded.Accepted || decoded.Observation == nil {
		t.Fatalf("lookup was not accepted: %+v", decoded)
	}
	if decoded.Observation.WrapperBytes != len([]byte(wrapper)) || !strings.HasSuffix(decoded.Observation.WrapperPreview, "...") {
		t.Fatalf("unexpected wrapper projection: %+v", decoded.Observation)
	}
	if len(decoded.Trace) != 2 || decoded.Trace[1].Source != "relay_mesh" || !decoded.Trace[1].Accepted {
		t.Fatalf("unexpected trace: %+v", decoded.Trace)
	}
	if provider.branchID != branchID {
		t.Fatalf("provider branch id = %q", provider.branchID)
	}
}

func TestHTTPHandlerRejectsInvalidIdentityContactLookup(t *testing.T) {
	handler := NewHTTPHandler(
		NewHandler(staticProvider{}, WithIdentityContactLookupProvider(&staticIdentityLookupProvider{})),
		AuthorizerFunc(func(*http.Request) bool { return true }),
	)
	request := httptest.NewRequest(http.MethodGet, IdentityContactLookupPath+"?branch_id=alice", nil)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusBadRequest)
	}
}

type staticIdentityLookupProvider struct {
	result   discovery.IdentityContactLookupResult
	branchID string
}

func (provider *staticIdentityLookupProvider) Lookup(_ context.Context, branchID string) discovery.IdentityContactLookupResult {
	provider.branchID = branchID
	if provider.result.BranchID == "" {
		return discovery.IdentityContactLookupResult{BranchID: branchID}
	}
	return provider.result
}
