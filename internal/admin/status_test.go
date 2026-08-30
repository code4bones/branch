package admin

import (
	"encoding/json"
	"strings"
	"testing"
)

type staticProvider struct {
	snapshot StatusSnapshot
}

func (provider staticProvider) Snapshot() StatusSnapshot {
	return provider.snapshot
}

func TestReadinessDoesNotExposePeerOrTopologyFields(t *testing.T) {
	handler := NewHandler(staticProvider{snapshot: StatusSnapshot{
		ServiceName:       "branch-node",
		ServiceVersion:    "0.0.0",
		Readiness:         ReadinessReady,
		ProtocolVersions:  []string{"branch/connectivity/0"},
		Capabilities:      []string{"forward"},
		SessionsActive:    2,
		QueueDepth:        1,
		ExporterAvailable: false,
	}})

	response := handler.Readiness()

	if response.StatusCode != StatusOK {
		t.Fatalf("status = %d", response.StatusCode)
	}
	body := string(response.Body)
	for _, forbidden := range []string{"peer", "topology", "address", "identity", "session_id"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("readiness exposed forbidden field %q in %s", forbidden, body)
		}
	}

	var decoded StatusSnapshot
	if err := json.Unmarshal(response.Body, &decoded); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if decoded.Readiness != ReadinessReady {
		t.Fatalf("readiness = %q", decoded.Readiness)
	}
}

func TestReadinessReturnsUnavailableWhenNotReady(t *testing.T) {
	handler := NewHandler(staticProvider{snapshot: StatusSnapshot{Readiness: ReadinessNotReady}})

	response := handler.Readiness()

	if response.StatusCode != StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", response.StatusCode, StatusServiceUnavailable)
	}
}

func TestLivenessIsMinimal(t *testing.T) {
	handler := NewHandler(staticProvider{})

	response := handler.Liveness()

	if response.StatusCode != StatusOK {
		t.Fatalf("status = %d", response.StatusCode)
	}
	if got := string(response.Body); !strings.Contains(got, "alive") {
		t.Fatalf("unexpected liveness body %s", got)
	}
}
