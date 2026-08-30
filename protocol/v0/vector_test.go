package v0

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

type vectorManifest struct {
	Schema   string       `json:"schema"`
	Protocol string       `json:"protocol"`
	Status   string       `json:"status"`
	Cases    []vectorCase `json:"cases"`
}

type vectorCase struct {
	Name    string `json:"name"`
	Kind    string `json:"kind"`
	Fixture string `json:"fixture"`
	Expect  string `json:"expect"`
}

func TestDraftEnvelopeVectors(t *testing.T) {
	root := filepath.Join("..", "..", "testdata", "vectors", "protocol-v0")
	manifestData, err := os.ReadFile(filepath.Join(root, "manifest.json"))
	if err != nil {
		t.Fatalf("read manifest: %v", err)
	}

	var manifest vectorManifest
	if err := json.Unmarshal(manifestData, &manifest); err != nil {
		t.Fatalf("decode manifest: %v", err)
	}
	if manifest.Schema != "branch.testvectors/0" {
		t.Fatalf("manifest schema = %q", manifest.Schema)
	}
	if manifest.Protocol != ProtocolID {
		t.Fatalf("manifest protocol = %q", manifest.Protocol)
	}
	if manifest.Status != "draft" {
		t.Fatalf("manifest status = %q", manifest.Status)
	}
	if len(manifest.Cases) == 0 {
		t.Fatal("manifest contains no vector cases")
	}

	for _, testCase := range manifest.Cases {
		t.Run(testCase.Name, func(t *testing.T) {
			if testCase.Kind != "draft_envelope_json" {
				t.Fatalf("unsupported vector kind %q", testCase.Kind)
			}

			data, err := os.ReadFile(filepath.Join(root, testCase.Fixture))
			if err != nil {
				t.Fatalf("read fixture: %v", err)
			}

			_, err = DecodeDraftEnvelope(data)
			switch testCase.Expect {
			case "accept-structure":
				if err != nil {
					t.Fatalf("expected fixture to pass structural validation: %v", err)
				}
			case "reject-structure":
				if !errors.Is(err, ErrInvalidEnvelope) {
					t.Fatalf("expected ErrInvalidEnvelope, got %v", err)
				}
			default:
				t.Fatalf("unsupported vector expectation %q", testCase.Expect)
			}
		})
	}
}
