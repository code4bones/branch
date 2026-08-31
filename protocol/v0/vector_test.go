package v0

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

type vectorManifest struct {
	Schema      string            `json:"schema"`
	Protocol    string            `json:"protocol"`
	Status      string            `json:"status"`
	Profile     vectorProfile     `json:"profile"`
	Transcripts vectorTranscripts `json:"transcripts"`
	Cases       []vectorCase      `json:"cases"`
}

type vectorProfile struct {
	Kind                 string `json:"kind"`
	Fixture              string `json:"fixture"`
	HashAlgorithm        string `json:"hash_algorithm"`
	DevelopmentMultihash string `json:"development_multihash"`
}

type vectorCase struct {
	Name    string `json:"name"`
	Kind    string `json:"kind"`
	Fixture string `json:"fixture"`
	Expect  string `json:"expect"`
}

type vectorTranscripts struct {
	Fixture                         string   `json:"fixture"`
	RequiredKinds                   []string `json:"required_kinds"`
	IndependentImplementationStatus string   `json:"independent_implementation_status"`
}

type transcriptBundle struct {
	Schema           string           `json:"schema"`
	Protocol         string           `json:"protocol"`
	ProfileMultihash string           `json:"profile_multihash"`
	Cases            []transcriptCase `json:"cases"`
	Independent      struct {
		Status string `json:"status"`
		Reason string `json:"reason"`
	} `json:"independent_implementation_requirement"`
}

type transcriptCase struct {
	Name                            string   `json:"name"`
	Kind                            string   `json:"kind"`
	Expect                          string   `json:"expect"`
	SelectedError                   *string  `json:"selected_error"`
	RestoresUserTrafficAfterRestart *bool    `json:"restores_user_traffic_after_restart"`
	Steps                           []string `json:"steps"`
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
	if manifest.Profile.Kind != "draft_profile_json" {
		t.Fatalf("profile kind = %q", manifest.Profile.Kind)
	}
	if manifest.Profile.HashAlgorithm != ProfileHashAlgorithm {
		t.Fatalf("profile hash algorithm = %q", manifest.Profile.HashAlgorithm)
	}

	profileData, err := os.ReadFile(filepath.Clean(filepath.Join(root, manifest.Profile.Fixture)))
	if err != nil {
		t.Fatalf("read profile fixture: %v", err)
	}
	if got := DraftProfileMultihash(profileData); got != manifest.Profile.DevelopmentMultihash {
		t.Fatalf("profile multihash = %q, want %q", got, manifest.Profile.DevelopmentMultihash)
	}
	assertTranscriptCoverage(t, root, manifest)

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

func assertTranscriptCoverage(t *testing.T, root string, manifest vectorManifest) {
	t.Helper()

	if manifest.Transcripts.IndependentImplementationStatus != "not-yet-demonstrated" {
		t.Fatalf("independent implementation status = %q", manifest.Transcripts.IndependentImplementationStatus)
	}

	data, err := os.ReadFile(filepath.Join(root, manifest.Transcripts.Fixture))
	if err != nil {
		t.Fatalf("read transcript fixture: %v", err)
	}

	var bundle transcriptBundle
	if err := json.Unmarshal(data, &bundle); err != nil {
		t.Fatalf("decode transcript fixture: %v", err)
	}
	if bundle.Schema != "branch.conformance.transcripts/0" {
		t.Fatalf("transcript schema = %q", bundle.Schema)
	}
	if bundle.Protocol != ProtocolID {
		t.Fatalf("transcript protocol = %q", bundle.Protocol)
	}
	if bundle.ProfileMultihash != manifest.Profile.DevelopmentMultihash {
		t.Fatalf("transcript profile hash = %q", bundle.ProfileMultihash)
	}
	if bundle.Independent.Status != manifest.Transcripts.IndependentImplementationStatus {
		t.Fatalf("transcript independent status = %q", bundle.Independent.Status)
	}

	seen := map[string]bool{}
	for _, testCase := range bundle.Cases {
		if testCase.Name == "" || testCase.Kind == "" || len(testCase.Steps) == 0 {
			t.Fatalf("invalid transcript case: %+v", testCase)
		}
		switch testCase.Expect {
		case "accept", "reject":
		default:
			t.Fatalf("unsupported transcript expectation %q", testCase.Expect)
		}
		if testCase.Expect == "reject" && testCase.SelectedError == nil {
			t.Fatalf("reject transcript %q has no selected error", testCase.Name)
		}
		if testCase.Kind == "relay_restart_transcript" {
			if testCase.RestoresUserTrafficAfterRestart == nil || *testCase.RestoresUserTrafficAfterRestart {
				t.Fatalf("relay restart transcript must prove no restored user traffic")
			}
		}
		seen[testCase.Kind] = true
	}

	for _, requiredKind := range manifest.Transcripts.RequiredKinds {
		if !seen[requiredKind] {
			t.Fatalf("missing required transcript kind %q", requiredKind)
		}
	}
}
