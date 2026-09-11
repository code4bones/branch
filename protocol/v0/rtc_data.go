package v0

import (
	"errors"
	"fmt"
)

const (
	// RTCDataVersion identifies endpoint-to-endpoint WebRTC DataChannel frames.
	// It is not a relay attachment protocol or relay capability.
	RTCDataVersion = "branch.rtc.data/0.draft"

	// The existing WSS outer ciphertext allowance is 8 KiB of base64url text;
	// its decoded byte representation is therefore bounded at 6 KiB.
	MaxRTCDataCiphertextBytes = 6 * 1024
	MaxRTCDataFrameBytes      = 8 * 1024
	MaxRTCAdmitFrameBytes     = 256
)

var ErrInvalidRTCData = errors.New("invalid rtc data")

// RTCData is an authenticated endpoint-to-endpoint outer delivery. Ciphertext
// is the decoded byte form of the existing HPKE sealed payload; adapters retain
// responsibility for identity binding, AAD reconstruction, and HPKE opening.
type RTCData struct {
	Version       string
	RTCSessionID  []byte
	OriginRouteID []byte
	PathEpoch     uint64
	StreamID      uint64
	DeliveryID    []byte
	AckRequested  bool
	Ciphertext    []byte
}

// RTCAdmit confirms only local acceptance and decryption for one direct
// delivery. It has no relay, durability, presentation, or receipt semantics.
type RTCAdmit struct {
	Version      string
	RTCSessionID []byte
	DeliveryID   []byte
}

// RTCDataFrame is the closed direct outer frame family.
type RTCDataFrame interface {
	rtcDataFrame()
}

func (RTCData) rtcDataFrame()  {}
func (RTCAdmit) rtcDataFrame() {}

// EncodeRTCData returns deterministic-CBOR DATA bytes.
func EncodeRTCData(data RTCData) ([]byte, error) {
	if err := data.Validate(); err != nil {
		return nil, err
	}
	return encodeRTCDataFrame(rtcDataMap(data), MaxRTCDataFrameBytes)
}

// DecodeRTCData accepts only a bounded, canonical, closed DATA map.
func DecodeRTCData(input []byte) (RTCData, error) {
	mapValue, err := decodeRTCDataMap(input, "rtc_data", MaxRTCDataFrameBytes)
	if err != nil {
		return RTCData{}, err
	}
	return decodeRTCDataFromMap(mapValue)
}

// Validate checks structural frame bounds without opening ciphertext or reading
// any session state.
func (data RTCData) Validate() error {
	if data.Version != RTCDataVersion || len(data.RTCSessionID) != 16 || len(data.OriginRouteID) != 16 || data.PathEpoch > MaxDraftTimestamp || data.StreamID > MaxDraftTimestamp || len(data.DeliveryID) != 16 || len(data.Ciphertext) == 0 || len(data.Ciphertext) > MaxRTCDataCiphertextBytes {
		return ErrInvalidRTCData
	}
	return nil
}

// EncodeRTCAdmit returns deterministic-CBOR ADMIT bytes.
func EncodeRTCAdmit(admit RTCAdmit) ([]byte, error) {
	if err := admit.Validate(); err != nil {
		return nil, err
	}
	return encodeRTCDataFrame(rtcAdmitMap(admit), MaxRTCAdmitFrameBytes)
}

// DecodeRTCAdmit accepts only a bounded, canonical, closed ADMIT map.
func DecodeRTCAdmit(input []byte) (RTCAdmit, error) {
	mapValue, err := decodeRTCDataMap(input, "rtc_admit", MaxRTCAdmitFrameBytes)
	if err != nil {
		return RTCAdmit{}, err
	}
	return decodeRTCAdmitFromMap(mapValue)
}

// Validate checks the structural ADMIT fields. The adapter checks that it
// matches an in-flight delivery before releasing a direct send slot.
func (admit RTCAdmit) Validate() error {
	if admit.Version != RTCDataVersion || len(admit.RTCSessionID) != 16 || len(admit.DeliveryID) != 16 {
		return ErrInvalidRTCData
	}
	return nil
}

// DecodeRTCDataFrame decodes either member of the closed direct frame family.
func DecodeRTCDataFrame(input []byte) (RTCDataFrame, error) {
	mapValue, err := decodeRTCDataMap(input, "rtc_data_frame", MaxRTCDataFrameBytes)
	if err != nil {
		return nil, err
	}
	kind, err := cborText(mapValue, "kind")
	if err != nil {
		return nil, rtcDataError(err)
	}
	switch kind {
	case "data":
		return decodeRTCDataFromMap(mapValue)
	case "admit":
		if len(input) > MaxRTCAdmitFrameBytes {
			return nil, ErrInvalidRTCData
		}
		return decodeRTCAdmitFromMap(mapValue)
	default:
		return nil, ErrInvalidRTCData
	}
}

func rtcDataMap(data RTCData) cborMapValue {
	return cborMapValue{entries: []cborEntry{
		{key: "kind", value: "data"},
		{key: "version", value: data.Version},
		{key: "rtc_session_id", value: append([]byte(nil), data.RTCSessionID...)},
		{key: "origin_route_id", value: append([]byte(nil), data.OriginRouteID...)},
		{key: "path_epoch", value: data.PathEpoch},
		{key: "stream_id", value: data.StreamID},
		{key: "delivery_id", value: append([]byte(nil), data.DeliveryID...)},
		{key: "ack_requested", value: data.AckRequested},
		{key: "ciphertext", value: append([]byte(nil), data.Ciphertext...)},
	}}
}

func rtcAdmitMap(admit RTCAdmit) cborMapValue {
	return cborMapValue{entries: []cborEntry{
		{key: "kind", value: "admit"},
		{key: "version", value: admit.Version},
		{key: "rtc_session_id", value: append([]byte(nil), admit.RTCSessionID...)},
		{key: "delivery_id", value: append([]byte(nil), admit.DeliveryID...)},
	}}
}

func decodeRTCDataFromMap(mapValue cborMapValue) (RTCData, error) {
	if err := rtcDataKind(mapValue, "data"); err != nil {
		return RTCData{}, err
	}
	if err := cborRejectUnknown(mapValue, []string{"kind", "version", "rtc_session_id", "origin_route_id", "path_epoch", "stream_id", "delivery_id", "ack_requested", "ciphertext"}); err != nil {
		return RTCData{}, rtcDataError(err)
	}
	version, err := rtcDataVersion(mapValue)
	if err != nil {
		return RTCData{}, err
	}
	sessionID, err := cborBytes(mapValue, "rtc_session_id", 16)
	if err != nil {
		return RTCData{}, rtcDataError(err)
	}
	originRouteID, err := cborBytes(mapValue, "origin_route_id", 16)
	if err != nil {
		return RTCData{}, rtcDataError(err)
	}
	pathEpoch, err := cborUint(mapValue, "path_epoch")
	if err != nil {
		return RTCData{}, rtcDataError(err)
	}
	streamID, err := cborUint(mapValue, "stream_id")
	if err != nil {
		return RTCData{}, rtcDataError(err)
	}
	deliveryID, err := cborBytes(mapValue, "delivery_id", 16)
	if err != nil {
		return RTCData{}, rtcDataError(err)
	}
	ackRequested, err := cborBool(mapValue, "ack_requested")
	if err != nil {
		return RTCData{}, rtcDataError(err)
	}
	ciphertext, err := cborBytes(mapValue, "ciphertext", 0)
	if err != nil {
		return RTCData{}, rtcDataError(err)
	}
	data := RTCData{Version: version, RTCSessionID: sessionID, OriginRouteID: originRouteID, PathEpoch: pathEpoch, StreamID: streamID, DeliveryID: deliveryID, AckRequested: ackRequested, Ciphertext: ciphertext}
	if err := data.Validate(); err != nil {
		return RTCData{}, err
	}
	return data, nil
}

func decodeRTCAdmitFromMap(mapValue cborMapValue) (RTCAdmit, error) {
	if err := rtcDataKind(mapValue, "admit"); err != nil {
		return RTCAdmit{}, err
	}
	if err := cborRejectUnknown(mapValue, []string{"kind", "version", "rtc_session_id", "delivery_id"}); err != nil {
		return RTCAdmit{}, rtcDataError(err)
	}
	version, err := rtcDataVersion(mapValue)
	if err != nil {
		return RTCAdmit{}, err
	}
	sessionID, err := cborBytes(mapValue, "rtc_session_id", 16)
	if err != nil {
		return RTCAdmit{}, rtcDataError(err)
	}
	deliveryID, err := cborBytes(mapValue, "delivery_id", 16)
	if err != nil {
		return RTCAdmit{}, rtcDataError(err)
	}
	admit := RTCAdmit{Version: version, RTCSessionID: sessionID, DeliveryID: deliveryID}
	if err := admit.Validate(); err != nil {
		return RTCAdmit{}, err
	}
	return admit, nil
}

func encodeRTCDataFrame(value cborMapValue, maximumBytes int) ([]byte, error) {
	encoded, err := encodeCbor(value)
	if err != nil || len(encoded) == 0 || len(encoded) > maximumBytes {
		return nil, ErrInvalidRTCData
	}
	return encoded, nil
}

func decodeRTCDataMap(input []byte, label string, maximumBytes int) (cborMapValue, error) {
	if len(input) == 0 || len(input) > maximumBytes {
		return cborMapValue{}, ErrInvalidRTCData
	}
	value, err := decodeDeterministicCBOR(input)
	if err != nil {
		return cborMapValue{}, rtcDataError(err)
	}
	mapValue, err := cborMap(value, label)
	if err != nil {
		return cborMapValue{}, rtcDataError(err)
	}
	return mapValue, nil
}

func rtcDataKind(mapValue cborMapValue, expected string) error {
	kind, err := cborText(mapValue, "kind")
	if err != nil || kind != expected {
		return ErrInvalidRTCData
	}
	return nil
}

func rtcDataVersion(mapValue cborMapValue) (string, error) {
	version, err := cborText(mapValue, "version")
	if err != nil || version != RTCDataVersion {
		return "", ErrInvalidRTCData
	}
	return version, nil
}

func rtcDataError(err error) error {
	if errors.Is(err, ErrInvalidRTCData) {
		return ErrInvalidRTCData
	}
	return fmt.Errorf("%w: %v", ErrInvalidRTCData, err)
}
