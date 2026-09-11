package v0

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestRTCDataAndAdmitCanonicalRoundTrip(t *testing.T) {
	data := RTCData{
		Version:       RTCDataVersion,
		RTCSessionID:  fixedRTCDataBytes(16, 1),
		OriginRouteID: fixedRTCDataBytes(16, 2),
		PathEpoch:     3,
		StreamID:      4,
		DeliveryID:    fixedRTCDataBytes(16, 5),
		AckRequested:  true,
		Ciphertext:    fixedRTCDataBytes(32, 6),
	}
	encodedData, err := EncodeRTCData(data)
	if err != nil {
		t.Fatal(err)
	}
	decodedData, err := DecodeRTCData(encodedData)
	if err != nil {
		t.Fatal(err)
	}
	if !equalRTCData(decodedData, data) {
		t.Fatalf("data changed during canonical round trip: %#v", decodedData)
	}
	canonicalData, err := EncodeRTCData(decodedData)
	if err != nil || !bytes.Equal(canonicalData, encodedData) {
		t.Fatalf("data canonical re-encode = %x, %v", canonicalData, err)
	}
	frame, err := DecodeRTCDataFrame(encodedData)
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := frame.(RTCData); !ok || !equalRTCData(got, data) {
		t.Fatalf("data frame = %#v", frame)
	}

	admit := RTCAdmit{Version: RTCDataVersion, RTCSessionID: data.RTCSessionID, DeliveryID: data.DeliveryID}
	encodedAdmit, err := EncodeRTCAdmit(admit)
	if err != nil {
		t.Fatal(err)
	}
	decodedAdmit, err := DecodeRTCAdmit(encodedAdmit)
	if err != nil {
		t.Fatal(err)
	}
	if !equalRTCAdmit(decodedAdmit, admit) {
		t.Fatalf("admit changed during canonical round trip: %#v", decodedAdmit)
	}
	frame, err = DecodeRTCDataFrame(encodedAdmit)
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := frame.(RTCAdmit); !ok || !equalRTCAdmit(got, admit) {
		t.Fatalf("admit frame = %#v", frame)
	}
}

func TestRTCDataUsesCanonicalCBORBooleans(t *testing.T) {
	encodedTrue, err := encodeCbor(true)
	if err != nil || !bytes.Equal(encodedTrue, []byte{0xf5}) {
		t.Fatalf("true = %x, %v", encodedTrue, err)
	}
	encodedFalse, err := encodeCbor(false)
	if err != nil || !bytes.Equal(encodedFalse, []byte{0xf4}) {
		t.Fatalf("false = %x, %v", encodedFalse, err)
	}
	decodedTrue, err := decodeDeterministicCBOR([]byte{0xf5})
	if err != nil || decodedTrue != true {
		t.Fatalf("decoded true = %#v, %v", decodedTrue, err)
	}
	decodedFalse, err := decodeDeterministicCBOR([]byte{0xf4})
	if err != nil || decodedFalse != false {
		t.Fatalf("decoded false = %#v, %v", decodedFalse, err)
	}
	if _, err := decodeDeterministicCBOR([]byte{0xf6}); err == nil {
		t.Fatal("null simple value accepted")
	}
}

func TestRTCDataRejectsRelayFieldsMalformedBooleanAndNonCanonicalCBOR(t *testing.T) {
	data := rtcDataForTest()
	entries := append(rtcDataMap(data).entries, cborEntry{key: "route_id", value: fixedRTCDataBytes(16, 9)})
	relayShaped, err := encodeCbor(cborMapValue{entries: entries})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeRTCData(relayShaped); !errors.Is(err, ErrInvalidRTCData) {
		t.Fatalf("relay field error = %v", err)
	}

	malformedEntries := rtcDataMap(data).entries
	for index := range malformedEntries {
		if malformedEntries[index].key == "ack_requested" {
			malformedEntries[index].value = uint64(1)
		}
	}
	numericAck, err := encodeCbor(cborMapValue{entries: malformedEntries})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeRTCData(numericAck); !errors.Is(err, ErrInvalidRTCData) {
		t.Fatalf("numeric ack error = %v", err)
	}

	unknownKind, err := encodeCbor(cborMapValue{entries: []cborEntry{{key: "kind", value: "relay_ack"}, {key: "version", value: RTCDataVersion}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeRTCDataFrame(unknownKind); !errors.Is(err, ErrInvalidRTCData) {
		t.Fatalf("unknown kind error = %v", err)
	}
	if _, err := DecodeRTCData([]byte{0xb8, 0x00}); !errors.Is(err, ErrInvalidRTCData) {
		t.Fatalf("non-canonical map error = %v", err)
	}
}

func TestRTCDataBoundsCiphertextAndSequences(t *testing.T) {
	maximum := rtcDataForTest()
	maximum.Ciphertext = fixedRTCDataBytes(MaxRTCDataCiphertextBytes, 8)
	encoded, err := EncodeRTCData(maximum)
	if err != nil {
		t.Fatal(err)
	}
	if len(encoded) > MaxRTCDataFrameBytes {
		t.Fatalf("maximum frame = %d", len(encoded))
	}
	if decoded, err := DecodeRTCData(encoded); err != nil || len(decoded.Ciphertext) != MaxRTCDataCiphertextBytes {
		t.Fatalf("maximum data = %#v, %v", decoded, err)
	}

	overlong := maximum
	overlong.Ciphertext = fixedRTCDataBytes(MaxRTCDataCiphertextBytes+1, 8)
	if _, err := EncodeRTCData(overlong); !errors.Is(err, ErrInvalidRTCData) {
		t.Fatalf("overlong ciphertext error = %v", err)
	}
	negativeEquivalent := rtcDataForTest()
	negativeEquivalent.PathEpoch = MaxDraftTimestamp + 1
	if _, err := EncodeRTCData(negativeEquivalent); !errors.Is(err, ErrInvalidRTCData) {
		t.Fatalf("out of range epoch error = %v", err)
	}
}

func TestRTCDataSharedVectors(t *testing.T) {
	bytes, err := os.ReadFile(filepath.Join("..", "..", "testdata", "vectors", "protocol-v0", "rtc-data-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Valid struct {
			Data struct {
				RTCSessionID   string `json:"rtc_session_id"`
				OriginRouteID  string `json:"origin_route_id"`
				PathEpoch      uint64 `json:"path_epoch"`
				StreamID       uint64 `json:"stream_id"`
				DeliveryID     string `json:"delivery_id"`
				AckRequested   bool   `json:"ack_requested"`
				Ciphertext     string `json:"ciphertext"`
				CanonicalFrame string `json:"canonical_frame"`
			} `json:"data"`
			Admit struct {
				RTCSessionID   string `json:"rtc_session_id"`
				DeliveryID     string `json:"delivery_id"`
				CanonicalFrame string `json:"canonical_frame"`
			} `json:"admit"`
		} `json:"valid"`
		InvalidFrame map[string]string `json:"invalid_frame"`
	}
	if err := json.Unmarshal(bytes, &fixture); err != nil {
		t.Fatal(err)
	}
	decode := func(value string) []byte {
		out, err := base64.RawURLEncoding.DecodeString(value)
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	data, err := EncodeRTCData(RTCData{Version: RTCDataVersion, RTCSessionID: decode(fixture.Valid.Data.RTCSessionID), OriginRouteID: decode(fixture.Valid.Data.OriginRouteID), PathEpoch: fixture.Valid.Data.PathEpoch, StreamID: fixture.Valid.Data.StreamID, DeliveryID: decode(fixture.Valid.Data.DeliveryID), AckRequested: fixture.Valid.Data.AckRequested, Ciphertext: decode(fixture.Valid.Data.Ciphertext)})
	if err != nil || base64.RawURLEncoding.EncodeToString(data) != fixture.Valid.Data.CanonicalFrame {
		t.Fatalf("shared data = %v", err)
	}
	admit, err := EncodeRTCAdmit(RTCAdmit{Version: RTCDataVersion, RTCSessionID: decode(fixture.Valid.Admit.RTCSessionID), DeliveryID: decode(fixture.Valid.Admit.DeliveryID)})
	if err != nil || base64.RawURLEncoding.EncodeToString(admit) != fixture.Valid.Admit.CanonicalFrame {
		t.Fatalf("shared admit = %v", err)
	}
	for name, frame := range fixture.InvalidFrame {
		if _, err := DecodeRTCDataFrame(decode(frame)); !errors.Is(err, ErrInvalidRTCData) {
			t.Fatalf("%s = %v", name, err)
		}
	}
}

func rtcDataForTest() RTCData {
	return RTCData{
		Version:       RTCDataVersion,
		RTCSessionID:  fixedRTCDataBytes(16, 1),
		OriginRouteID: fixedRTCDataBytes(16, 2),
		PathEpoch:     3,
		StreamID:      4,
		DeliveryID:    fixedRTCDataBytes(16, 5),
		AckRequested:  true,
		Ciphertext:    fixedRTCDataBytes(32, 6),
	}
}

func fixedRTCDataBytes(size int, value byte) []byte {
	return bytes.Repeat([]byte{value}, size)
}

func equalRTCData(left, right RTCData) bool {
	return left.Version == right.Version && bytes.Equal(left.RTCSessionID, right.RTCSessionID) && bytes.Equal(left.OriginRouteID, right.OriginRouteID) && left.PathEpoch == right.PathEpoch && left.StreamID == right.StreamID && bytes.Equal(left.DeliveryID, right.DeliveryID) && left.AckRequested == right.AckRequested && bytes.Equal(left.Ciphertext, right.Ciphertext)
}

func equalRTCAdmit(left, right RTCAdmit) bool {
	return left.Version == right.Version && bytes.Equal(left.RTCSessionID, right.RTCSessionID) && bytes.Equal(left.DeliveryID, right.DeliveryID)
}
