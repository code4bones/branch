package v0

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestApplicationControlCanonicalEnvelopeAndSigningBytes(t *testing.T) {
	control := ApplicationControl{
		Version:         ApplicationControlVersion,
		Kind:            RTCOfferControlKind,
		ControlID:       fixedRTCBytes(16, 1),
		IssuedAt:        1_700_000_000_000,
		ExpiresAt:       1_700_000_060_000,
		SenderPeerID:    fixedRTCBytes(32, 2),
		RecipientPeerID: fixedRTCBytes(32, 3),
		Body:            []byte{0xa1, 0x61, 0x78, 0x01},
		Signature:       fixedRTCBytes(64, 4),
	}
	encoded, err := EncodeApplicationControl(control)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeApplicationControl(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(decoded.ControlID, control.ControlID) || !bytes.Equal(decoded.Signature, control.Signature) || !bytes.Equal(decoded.Body, control.Body) {
		t.Fatal("application control changed during canonical round trip")
	}
	signingBytes, err := ApplicationControlSigningBytes(control)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(signingBytes, []byte(ApplicationControlSignatureDomain)) || bytes.Contains(signingBytes, control.Signature) {
		t.Fatal("application-control signing input does not exclude the signature")
	}

	unsigned := control
	unsigned.Signature = nil
	encodedUnsigned, err := EncodeApplicationControl(unsigned)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeApplicationControl(encodedUnsigned); err != nil {
		t.Fatalf("optional empty signature rejected: %v", err)
	}

	unknown, err := encodeCbor(cborMapValue{entries: append(applicationControlMap(control, true).entries, cborEntry{key: "unexpected", value: "no"})})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeApplicationControl(unknown); !errors.Is(err, ErrInvalidApplicationControl) {
		t.Fatalf("unknown control field error = %v", err)
	}
}

func TestRTCSignalingBodiesRoundTrip(t *testing.T) {
	description := rtcDescription(9)
	descriptionHash := rtcDigest(description)
	fingerprint := fixedRTCBytes(32, 9)
	sessionID := fixedRTCBytes(16, 7)

	capabilities := RTCCapabilities{Version: RTCSignalingVersion, MaxDescriptionBytes: MaxRTCDescriptionBytes, MaxCandidateBytes: MaxRTCCandidateBytes, MaxCandidatesPerDirection: MaxRTCCandidatesPerDirection}
	encodedCapabilities, err := EncodeRTCCapabilities(capabilities)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := DecodeRTCCapabilities(encodedCapabilities); err != nil || got != capabilities {
		t.Fatalf("capabilities round trip = %#v, %v", got, err)
	}

	offer := RTCOffer{Version: RTCSignalingVersion, RTCSessionID: sessionID, Generation: 2, Description: description, DescriptionSHA256: descriptionHash, DTLSFingerprintSHA256: fingerprint}
	encodedOffer, err := EncodeRTCOffer(offer)
	if err != nil {
		t.Fatal(err)
	}
	decodedOffer, err := DecodeRTCOffer(encodedOffer)
	if err != nil || !equalRTCOffer(decodedOffer, offer) {
		t.Fatalf("offer round trip = %#v, %v", decodedOffer, err)
	}
	maximumDescription := string(bytes.Repeat([]byte("s"), MaxRTCDescriptionBytes))
	maximumOffer := offer
	maximumOffer.Description = maximumDescription
	maximumOffer.DescriptionSHA256 = rtcDigest(maximumDescription)
	encodedMaximumOffer, err := EncodeRTCOffer(maximumOffer)
	if err != nil {
		t.Fatal(err)
	}
	if decoded, err := DecodeRTCOffer(encodedMaximumOffer); err != nil || decoded.Description != maximumDescription {
		t.Fatalf("1536-byte description round trip = %#v, %v", decoded, err)
	}

	answer := RTCAnswer{Version: RTCSignalingVersion, RTCSessionID: sessionID, Generation: 2, Description: description, DescriptionSHA256: descriptionHash, DTLSFingerprintSHA256: fingerprint, OfferDescriptionSHA256: fixedRTCBytes(32, 10)}
	encodedAnswer, err := EncodeRTCAnswer(answer)
	if err != nil {
		t.Fatal(err)
	}
	decodedAnswer, err := DecodeRTCAnswer(encodedAnswer)
	if err != nil || !bytes.Equal(decodedAnswer.OfferDescriptionSHA256, answer.OfferDescriptionSHA256) {
		t.Fatalf("answer round trip = %#v, %v", decodedAnswer, err)
	}

	candidate := RTCCandidate{Version: RTCSignalingVersion, RTCSessionID: sessionID, Generation: 2, Direction: RTCCandidateDirectionOfferer, DescriptionSHA256: descriptionHash, Candidate: "candidate:1 1 UDP 1 192.0.2.1 9 typ host"}
	encodedCandidate, err := EncodeRTCCandidate(candidate)
	if err != nil {
		t.Fatal(err)
	}
	decodedCandidate, err := DecodeRTCCandidate(encodedCandidate)
	if err != nil || decodedCandidate.Direction != candidate.Direction || decodedCandidate.Candidate != candidate.Candidate {
		t.Fatalf("candidate round trip = %#v, %v", decodedCandidate, err)
	}

	restart := RTCRestart{Version: RTCSignalingVersion, RTCSessionID: sessionID, Generation: 3, PriorDescriptionSHA256: descriptionHash, Description: description, DescriptionSHA256: descriptionHash, DTLSFingerprintSHA256: fingerprint}
	encodedRestart, err := EncodeRTCRestart(restart)
	if err != nil {
		t.Fatal(err)
	}
	decodedRestart, err := DecodeRTCRestart(encodedRestart)
	if err != nil || !bytes.Equal(decodedRestart.PriorDescriptionSHA256, restart.PriorDescriptionSHA256) {
		t.Fatalf("restart round trip = %#v, %v", decodedRestart, err)
	}

	cancel := RTCCancel{Version: RTCSignalingVersion, RTCSessionID: sessionID, Generation: 3, DescriptionSHA256: descriptionHash, Reason: RTCCancelReasonGlare}
	encodedCancel, err := EncodeRTCCancel(cancel)
	if err != nil {
		t.Fatal(err)
	}
	decodedCancel, err := DecodeRTCCancel(encodedCancel)
	if err != nil || decodedCancel.Reason != cancel.Reason {
		t.Fatalf("cancel round trip = %#v, %v", decodedCancel, err)
	}
}

func TestRTCSignalingRejectsInvalidBodies(t *testing.T) {
	description := rtcDescription(2)
	digest := rtcDigest(description)
	offer := RTCOffer{Version: RTCSignalingVersion, RTCSessionID: fixedRTCBytes(16, 1), Generation: 1, Description: description, DescriptionSHA256: digest, DTLSFingerprintSHA256: fixedRTCBytes(32, 2)}

	badHash := offer
	badHash.DescriptionSHA256 = fixedRTCBytes(32, 8)
	if _, err := EncodeRTCOffer(badHash); !errors.Is(err, ErrInvalidRTCSignaling) {
		t.Fatalf("description hash mismatch = %v", err)
	}
	tooLong := offer
	tooLong.Description = string(bytes.Repeat([]byte("a"), MaxRTCDescriptionBytes+1))
	tooLong.DescriptionSHA256 = rtcDigest(tooLong.Description)
	if _, err := EncodeRTCOffer(tooLong); !errors.Is(err, ErrInvalidRTCSignaling) {
		t.Fatalf("overlong description = %v", err)
	}
	badDirection := RTCCandidate{Version: RTCSignalingVersion, RTCSessionID: offer.RTCSessionID, Generation: 1, Direction: "both", DescriptionSHA256: digest, Candidate: "candidate"}
	if _, err := EncodeRTCCandidate(badDirection); !errors.Is(err, ErrInvalidRTCSignaling) {
		t.Fatalf("invalid candidate direction = %v", err)
	}
	overlongCandidate := RTCCandidate{Version: RTCSignalingVersion, RTCSessionID: offer.RTCSessionID, Generation: 1, Direction: RTCCandidateDirectionAnswerer, DescriptionSHA256: digest, Candidate: string(bytes.Repeat([]byte("a"), MaxRTCCandidateBytes+1))}
	if _, err := EncodeRTCCandidate(overlongCandidate); !errors.Is(err, ErrInvalidRTCSignaling) {
		t.Fatalf("overlong candidate = %v", err)
	}
	badCancel := RTCCancel{Version: RTCSignalingVersion, RTCSessionID: offer.RTCSessionID, Generation: 1, DescriptionSHA256: digest, Reason: "freeform"}
	if _, err := EncodeRTCCancel(badCancel); !errors.Is(err, ErrInvalidRTCSignaling) {
		t.Fatalf("freeform cancel reason = %v", err)
	}

	unknownField, err := encodeCbor(cborMapValue{entries: append(rtcOfferMap(offer).entries, cborEntry{key: "url", value: "https://invalid.example"})})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeRTCOffer(unknownField); !errors.Is(err, ErrInvalidRTCSignaling) {
		t.Fatalf("unknown offer field = %v", err)
	}
}

func TestRTCSignalingSharedVectors(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "testdata", "vectors", "protocol-v0", "rtc-signaling-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Valid struct {
			Description           string `json:"description"`
			DescriptionSHA256     string `json:"description_sha256"`
			DTLSFingerprintSHA256 string `json:"dtls_fingerprint_sha256"`
			SessionID             string `json:"session_id"`
			CanonicalBody         struct {
				Capabilities string `json:"capabilities"`
				Offer        string `json:"offer"`
				Answer       string `json:"answer"`
				Candidate    string `json:"candidate"`
				Restart      string `json:"restart"`
				Cancel       string `json:"cancel"`
			} `json:"canonical_body"`
		} `json:"valid"`
		InvalidBody struct {
			DescriptionHashSubstitution string `json:"description_hash_substitution"`
			CandidateInvalidDirection   string `json:"candidate_invalid_direction"`
		} `json:"invalid_body"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	decode := func(value string) []byte {
		out, err := base64.RawURLEncoding.DecodeString(value)
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	offer := RTCOffer{Version: RTCSignalingVersion, RTCSessionID: decode(fixture.Valid.SessionID), Generation: 0, Description: fixture.Valid.Description, DescriptionSHA256: decode(fixture.Valid.DescriptionSHA256), DTLSFingerprintSHA256: decode(fixture.Valid.DTLSFingerprintSHA256)}
	cases := []struct {
		name   string
		want   string
		encode func() ([]byte, error)
	}{
		{"capabilities", fixture.Valid.CanonicalBody.Capabilities, func() ([]byte, error) {
			return EncodeRTCCapabilities(RTCCapabilities{Version: RTCSignalingVersion, MaxDescriptionBytes: MaxRTCDescriptionBytes, MaxCandidateBytes: MaxRTCCandidateBytes, MaxCandidatesPerDirection: MaxRTCCandidatesPerDirection})
		}},
		{"offer", fixture.Valid.CanonicalBody.Offer, func() ([]byte, error) { return EncodeRTCOffer(offer) }},
		{"answer", fixture.Valid.CanonicalBody.Answer, func() ([]byte, error) {
			return EncodeRTCAnswer(RTCAnswer{Version: offer.Version, RTCSessionID: offer.RTCSessionID, Generation: 1, Description: offer.Description, DescriptionSHA256: offer.DescriptionSHA256, DTLSFingerprintSHA256: offer.DTLSFingerprintSHA256, OfferDescriptionSHA256: offer.DescriptionSHA256})
		}},
		{"candidate", fixture.Valid.CanonicalBody.Candidate, func() ([]byte, error) {
			return EncodeRTCCandidate(RTCCandidate{Version: offer.Version, RTCSessionID: offer.RTCSessionID, Generation: 1, Direction: RTCCandidateDirectionOfferer, DescriptionSHA256: offer.DescriptionSHA256, Candidate: "candidate:1 1 UDP 1 192.0.2.1 9 typ host"})
		}},
		{"restart", fixture.Valid.CanonicalBody.Restart, func() ([]byte, error) {
			return EncodeRTCRestart(RTCRestart{Version: offer.Version, RTCSessionID: offer.RTCSessionID, Generation: 2, PriorDescriptionSHA256: offer.DescriptionSHA256, Description: offer.Description, DescriptionSHA256: offer.DescriptionSHA256, DTLSFingerprintSHA256: offer.DTLSFingerprintSHA256})
		}},
		{"cancel", fixture.Valid.CanonicalBody.Cancel, func() ([]byte, error) {
			return EncodeRTCCancel(RTCCancel{Version: offer.Version, RTCSessionID: offer.RTCSessionID, Generation: 2, DescriptionSHA256: offer.DescriptionSHA256, Reason: RTCCancelReasonGlare})
		}},
	}
	for _, test := range cases {
		body, err := test.encode()
		if err != nil {
			t.Fatalf("%s: %v", test.name, err)
		}
		if got := base64.RawURLEncoding.EncodeToString(body); got != test.want {
			t.Fatalf("shared %s body = %s", test.name, got)
		}
	}
	if _, err := DecodeRTCOffer(decode(fixture.InvalidBody.DescriptionHashSubstitution)); !errors.Is(err, ErrInvalidRTCSignaling) {
		t.Fatalf("shared substituted description hash error = %v", err)
	}
	if _, err := DecodeRTCCandidate(decode(fixture.InvalidBody.CandidateInvalidDirection)); !errors.Is(err, ErrInvalidRTCSignaling) {
		t.Fatalf("shared invalid candidate direction error = %v", err)
	}
}

func fixedRTCBytes(size int, value byte) []byte {
	return bytes.Repeat([]byte{value}, size)
}

func rtcDigest(value string) []byte {
	digest := sha256.Sum256([]byte(value))
	return append([]byte(nil), digest[:]...)
}

func rtcDescription(fingerprintByte byte) string {
	parts := make([]byte, 0, 95)
	for index := 0; index < 32; index++ {
		if index > 0 {
			parts = append(parts, ':')
		}
		const hex = "0123456789ABCDEF"
		parts = append(parts, hex[fingerprintByte>>4], hex[fingerprintByte&0x0f])
	}
	return "v=0\r\na=fingerprint:sha-256 " + string(parts) + "\r\n"
}

func equalRTCOffer(left, right RTCOffer) bool {
	return left.Version == right.Version && left.Generation == right.Generation && left.Description == right.Description && bytes.Equal(left.RTCSessionID, right.RTCSessionID) && bytes.Equal(left.DescriptionSHA256, right.DescriptionSHA256) && bytes.Equal(left.DTLSFingerprintSHA256, right.DTLSFingerprintSHA256)
}
