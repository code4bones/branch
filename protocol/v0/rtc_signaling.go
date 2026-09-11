package v0

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"unicode/utf8"
)

const (
	RTCSignalingVersion = "branch.rtc.signaling/0.draft"

	RTCCapabilitiesControlKind = "branch.rtc.capabilities/0.draft"
	RTCOfferControlKind        = "branch.rtc.offer/0.draft"
	RTCAnswerControlKind       = "branch.rtc.answer/0.draft"
	RTCCandidateControlKind    = "branch.rtc.candidate/0.draft"
	RTCRestartControlKind      = "branch.rtc.restart/0.draft"
	RTCCancelControlKind       = "branch.rtc.cancel/0.draft"

	MaxRTCDescriptionBytes       = 1536
	MaxRTCCandidateBytes         = 1024
	MaxRTCCandidatesPerDirection = 32
	MaxRTCGeneration             = 65535
)

var ErrInvalidRTCSignaling = errors.New("invalid rtc signaling")

type RTCCapabilities struct {
	Version                   string
	MaxDescriptionBytes       uint64
	MaxCandidateBytes         uint64
	MaxCandidatesPerDirection uint64
}

type RTCOffer struct {
	Version               string
	RTCSessionID          []byte
	Generation            uint64
	Description           string
	DescriptionSHA256     []byte
	DTLSFingerprintSHA256 []byte
}

type RTCAnswer struct {
	Version                string
	RTCSessionID           []byte
	Generation             uint64
	Description            string
	DescriptionSHA256      []byte
	DTLSFingerprintSHA256  []byte
	OfferDescriptionSHA256 []byte
}

type RTCCandidateDirection string

const (
	RTCCandidateDirectionOfferer  RTCCandidateDirection = "offerer"
	RTCCandidateDirectionAnswerer RTCCandidateDirection = "answerer"
)

type RTCCandidate struct {
	Version           string
	RTCSessionID      []byte
	Generation        uint64
	Direction         RTCCandidateDirection
	DescriptionSHA256 []byte
	Candidate         string
}

type RTCRestart struct {
	Version                string
	RTCSessionID           []byte
	Generation             uint64
	PriorDescriptionSHA256 []byte
	Description            string
	DescriptionSHA256      []byte
	DTLSFingerprintSHA256  []byte
}

type RTCCancelReason string

const (
	RTCCancelReasonCancelled RTCCancelReason = "cancelled"
	RTCCancelReasonRejected  RTCCancelReason = "rejected"
	RTCCancelReasonGlare     RTCCancelReason = "glare"
)

type RTCCancel struct {
	Version           string
	RTCSessionID      []byte
	Generation        uint64
	DescriptionSHA256 []byte
	Reason            RTCCancelReason
}

func EncodeRTCCapabilities(capabilities RTCCapabilities) ([]byte, error) {
	if err := capabilities.Validate(); err != nil {
		return nil, err
	}
	return encodeRTCSignalingBody(rtcCapabilitiesMap(capabilities))
}

func DecodeRTCCapabilities(data []byte) (RTCCapabilities, error) {
	mapValue, err := decodeRTCSignalingMap(data, "rtc_capabilities", []string{"version", "max_description_bytes", "max_candidate_bytes", "max_candidates_per_direction"})
	if err != nil {
		return RTCCapabilities{}, err
	}
	version, err := rtcVersion(mapValue)
	if err != nil {
		return RTCCapabilities{}, err
	}
	maxDescriptionBytes, err := cborUint(mapValue, "max_description_bytes")
	if err != nil {
		return RTCCapabilities{}, rtcError(err)
	}
	maxCandidateBytes, err := cborUint(mapValue, "max_candidate_bytes")
	if err != nil {
		return RTCCapabilities{}, rtcError(err)
	}
	maxCandidatesPerDirection, err := cborUint(mapValue, "max_candidates_per_direction")
	if err != nil {
		return RTCCapabilities{}, rtcError(err)
	}
	capabilities := RTCCapabilities{Version: version, MaxDescriptionBytes: maxDescriptionBytes, MaxCandidateBytes: maxCandidateBytes, MaxCandidatesPerDirection: maxCandidatesPerDirection}
	if err := capabilities.Validate(); err != nil {
		return RTCCapabilities{}, err
	}
	return capabilities, nil
}

func (capabilities RTCCapabilities) Validate() error {
	if capabilities.Version != RTCSignalingVersion || capabilities.MaxDescriptionBytes == 0 || capabilities.MaxDescriptionBytes > MaxRTCDescriptionBytes || capabilities.MaxCandidateBytes == 0 || capabilities.MaxCandidateBytes > MaxRTCCandidateBytes || capabilities.MaxCandidatesPerDirection == 0 || capabilities.MaxCandidatesPerDirection > MaxRTCCandidatesPerDirection {
		return ErrInvalidRTCSignaling
	}
	return nil
}

func EncodeRTCOffer(offer RTCOffer) ([]byte, error) {
	if err := offer.Validate(); err != nil {
		return nil, err
	}
	return encodeRTCSignalingBody(rtcOfferMap(offer))
}

func DecodeRTCOffer(data []byte) (RTCOffer, error) {
	mapValue, err := decodeRTCSignalingMap(data, "rtc_offer", []string{"version", "rtc_session_id", "generation", "description", "description_sha256", "dtls_fingerprint_sha256"})
	if err != nil {
		return RTCOffer{}, err
	}
	offer, err := rtcOfferFromMap(mapValue)
	if err != nil {
		return RTCOffer{}, err
	}
	if err := offer.Validate(); err != nil {
		return RTCOffer{}, err
	}
	return offer, nil
}

func (offer RTCOffer) Validate() error {
	if err := validateRTCDescription(offer.Version, offer.RTCSessionID, offer.Generation, offer.Description, offer.DescriptionSHA256, offer.DTLSFingerprintSHA256); err != nil {
		return err
	}
	return nil
}

func EncodeRTCAnswer(answer RTCAnswer) ([]byte, error) {
	if err := answer.Validate(); err != nil {
		return nil, err
	}
	return encodeRTCSignalingBody(rtcAnswerMap(answer))
}

func DecodeRTCAnswer(data []byte) (RTCAnswer, error) {
	mapValue, err := decodeRTCSignalingMap(data, "rtc_answer", []string{"version", "rtc_session_id", "generation", "description", "description_sha256", "dtls_fingerprint_sha256", "offer_description_sha256"})
	if err != nil {
		return RTCAnswer{}, err
	}
	offer, err := rtcOfferFromMap(mapValue)
	if err != nil {
		return RTCAnswer{}, err
	}
	offerDescriptionSHA256, err := rtcHash(mapValue, "offer_description_sha256")
	if err != nil {
		return RTCAnswer{}, err
	}
	answer := RTCAnswer{Version: offer.Version, RTCSessionID: offer.RTCSessionID, Generation: offer.Generation, Description: offer.Description, DescriptionSHA256: offer.DescriptionSHA256, DTLSFingerprintSHA256: offer.DTLSFingerprintSHA256, OfferDescriptionSHA256: offerDescriptionSHA256}
	if err := answer.Validate(); err != nil {
		return RTCAnswer{}, err
	}
	return answer, nil
}

func (answer RTCAnswer) Validate() error {
	if err := validateRTCDescription(answer.Version, answer.RTCSessionID, answer.Generation, answer.Description, answer.DescriptionSHA256, answer.DTLSFingerprintSHA256); err != nil {
		return err
	}
	if len(answer.OfferDescriptionSHA256) != sha256.Size {
		return ErrInvalidRTCSignaling
	}
	return nil
}

func EncodeRTCCandidate(candidate RTCCandidate) ([]byte, error) {
	if err := candidate.Validate(); err != nil {
		return nil, err
	}
	return encodeRTCSignalingBody(rtcCandidateMap(candidate))
}

func DecodeRTCCandidate(data []byte) (RTCCandidate, error) {
	mapValue, err := decodeRTCSignalingMap(data, "rtc_candidate", []string{"version", "rtc_session_id", "generation", "direction", "description_sha256", "candidate"})
	if err != nil {
		return RTCCandidate{}, err
	}
	version, err := rtcVersion(mapValue)
	if err != nil {
		return RTCCandidate{}, err
	}
	sessionID, err := rtcSessionID(mapValue)
	if err != nil {
		return RTCCandidate{}, err
	}
	generation, err := rtcGeneration(mapValue)
	if err != nil {
		return RTCCandidate{}, err
	}
	direction, err := rtcCandidateDirection(mapValue)
	if err != nil {
		return RTCCandidate{}, err
	}
	descriptionSHA256, err := rtcHash(mapValue, "description_sha256")
	if err != nil {
		return RTCCandidate{}, err
	}
	candidateText, err := rtcText(mapValue, "candidate", MaxRTCCandidateBytes)
	if err != nil {
		return RTCCandidate{}, err
	}
	candidate := RTCCandidate{Version: version, RTCSessionID: sessionID, Generation: generation, Direction: direction, DescriptionSHA256: descriptionSHA256, Candidate: candidateText}
	if err := candidate.Validate(); err != nil {
		return RTCCandidate{}, err
	}
	return candidate, nil
}

func (candidate RTCCandidate) Validate() error {
	if err := validateRTCSession(candidate.Version, candidate.RTCSessionID, candidate.Generation); err != nil {
		return err
	}
	if candidate.Direction != RTCCandidateDirectionOfferer && candidate.Direction != RTCCandidateDirectionAnswerer || len(candidate.DescriptionSHA256) != sha256.Size || !validRTCText(candidate.Candidate, MaxRTCCandidateBytes) {
		return ErrInvalidRTCSignaling
	}
	return nil
}

func EncodeRTCRestart(restart RTCRestart) ([]byte, error) {
	if err := restart.Validate(); err != nil {
		return nil, err
	}
	return encodeRTCSignalingBody(rtcRestartMap(restart))
}

func DecodeRTCRestart(data []byte) (RTCRestart, error) {
	mapValue, err := decodeRTCSignalingMap(data, "rtc_restart", []string{"version", "rtc_session_id", "generation", "prior_description_sha256", "description", "description_sha256", "dtls_fingerprint_sha256"})
	if err != nil {
		return RTCRestart{}, err
	}
	offer, err := rtcOfferFromMap(mapValue)
	if err != nil {
		return RTCRestart{}, err
	}
	priorDescriptionSHA256, err := rtcHash(mapValue, "prior_description_sha256")
	if err != nil {
		return RTCRestart{}, err
	}
	restart := RTCRestart{Version: offer.Version, RTCSessionID: offer.RTCSessionID, Generation: offer.Generation, PriorDescriptionSHA256: priorDescriptionSHA256, Description: offer.Description, DescriptionSHA256: offer.DescriptionSHA256, DTLSFingerprintSHA256: offer.DTLSFingerprintSHA256}
	if err := restart.Validate(); err != nil {
		return RTCRestart{}, err
	}
	return restart, nil
}

func (restart RTCRestart) Validate() error {
	if err := validateRTCDescription(restart.Version, restart.RTCSessionID, restart.Generation, restart.Description, restart.DescriptionSHA256, restart.DTLSFingerprintSHA256); err != nil {
		return err
	}
	if len(restart.PriorDescriptionSHA256) != sha256.Size {
		return ErrInvalidRTCSignaling
	}
	return nil
}

func EncodeRTCCancel(cancel RTCCancel) ([]byte, error) {
	if err := cancel.Validate(); err != nil {
		return nil, err
	}
	return encodeRTCSignalingBody(rtcCancelMap(cancel))
}

func DecodeRTCCancel(data []byte) (RTCCancel, error) {
	mapValue, err := decodeRTCSignalingMap(data, "rtc_cancel", []string{"version", "rtc_session_id", "generation", "description_sha256", "reason"})
	if err != nil {
		return RTCCancel{}, err
	}
	version, err := rtcVersion(mapValue)
	if err != nil {
		return RTCCancel{}, err
	}
	sessionID, err := rtcSessionID(mapValue)
	if err != nil {
		return RTCCancel{}, err
	}
	generation, err := rtcGeneration(mapValue)
	if err != nil {
		return RTCCancel{}, err
	}
	descriptionSHA256, err := rtcHash(mapValue, "description_sha256")
	if err != nil {
		return RTCCancel{}, err
	}
	reasonText, err := cborText(mapValue, "reason")
	if err != nil {
		return RTCCancel{}, rtcError(err)
	}
	cancel := RTCCancel{Version: version, RTCSessionID: sessionID, Generation: generation, DescriptionSHA256: descriptionSHA256, Reason: RTCCancelReason(reasonText)}
	if err := cancel.Validate(); err != nil {
		return RTCCancel{}, err
	}
	return cancel, nil
}

func (cancel RTCCancel) Validate() error {
	if err := validateRTCSession(cancel.Version, cancel.RTCSessionID, cancel.Generation); err != nil {
		return err
	}
	if len(cancel.DescriptionSHA256) != sha256.Size || cancel.Reason != RTCCancelReasonCancelled && cancel.Reason != RTCCancelReasonRejected && cancel.Reason != RTCCancelReasonGlare {
		return ErrInvalidRTCSignaling
	}
	return nil
}

func rtcCapabilitiesMap(capabilities RTCCapabilities) cborMapValue {
	return cborMapValue{entries: []cborEntry{
		{key: "version", value: capabilities.Version},
		{key: "max_description_bytes", value: capabilities.MaxDescriptionBytes},
		{key: "max_candidate_bytes", value: capabilities.MaxCandidateBytes},
		{key: "max_candidates_per_direction", value: capabilities.MaxCandidatesPerDirection},
	}}
}

func rtcOfferMap(offer RTCOffer) cborMapValue {
	return cborMapValue{entries: []cborEntry{
		{key: "version", value: offer.Version},
		{key: "rtc_session_id", value: append([]byte(nil), offer.RTCSessionID...)},
		{key: "generation", value: offer.Generation},
		{key: "description", value: offer.Description},
		{key: "description_sha256", value: append([]byte(nil), offer.DescriptionSHA256...)},
		{key: "dtls_fingerprint_sha256", value: append([]byte(nil), offer.DTLSFingerprintSHA256...)},
	}}
}

func rtcAnswerMap(answer RTCAnswer) cborMapValue {
	entries := rtcOfferMap(RTCOffer{Version: answer.Version, RTCSessionID: answer.RTCSessionID, Generation: answer.Generation, Description: answer.Description, DescriptionSHA256: answer.DescriptionSHA256, DTLSFingerprintSHA256: answer.DTLSFingerprintSHA256}).entries
	entries = append(entries, cborEntry{key: "offer_description_sha256", value: append([]byte(nil), answer.OfferDescriptionSHA256...)})
	return cborMapValue{entries: entries}
}

func rtcCandidateMap(candidate RTCCandidate) cborMapValue {
	return cborMapValue{entries: []cborEntry{
		{key: "version", value: candidate.Version},
		{key: "rtc_session_id", value: append([]byte(nil), candidate.RTCSessionID...)},
		{key: "generation", value: candidate.Generation},
		{key: "direction", value: string(candidate.Direction)},
		{key: "description_sha256", value: append([]byte(nil), candidate.DescriptionSHA256...)},
		{key: "candidate", value: candidate.Candidate},
	}}
}

func rtcRestartMap(restart RTCRestart) cborMapValue {
	return cborMapValue{entries: []cborEntry{
		{key: "version", value: restart.Version},
		{key: "rtc_session_id", value: append([]byte(nil), restart.RTCSessionID...)},
		{key: "generation", value: restart.Generation},
		{key: "prior_description_sha256", value: append([]byte(nil), restart.PriorDescriptionSHA256...)},
		{key: "description", value: restart.Description},
		{key: "description_sha256", value: append([]byte(nil), restart.DescriptionSHA256...)},
		{key: "dtls_fingerprint_sha256", value: append([]byte(nil), restart.DTLSFingerprintSHA256...)},
	}}
}

func rtcCancelMap(cancel RTCCancel) cborMapValue {
	return cborMapValue{entries: []cborEntry{
		{key: "version", value: cancel.Version},
		{key: "rtc_session_id", value: append([]byte(nil), cancel.RTCSessionID...)},
		{key: "generation", value: cancel.Generation},
		{key: "description_sha256", value: append([]byte(nil), cancel.DescriptionSHA256...)},
		{key: "reason", value: string(cancel.Reason)},
	}}
}

func rtcOfferFromMap(mapValue cborMapValue) (RTCOffer, error) {
	version, err := rtcVersion(mapValue)
	if err != nil {
		return RTCOffer{}, err
	}
	sessionID, err := rtcSessionID(mapValue)
	if err != nil {
		return RTCOffer{}, err
	}
	generation, err := rtcGeneration(mapValue)
	if err != nil {
		return RTCOffer{}, err
	}
	description, err := rtcText(mapValue, "description", MaxRTCDescriptionBytes)
	if err != nil {
		return RTCOffer{}, err
	}
	descriptionSHA256, err := rtcHash(mapValue, "description_sha256")
	if err != nil {
		return RTCOffer{}, err
	}
	fingerprint, err := rtcHash(mapValue, "dtls_fingerprint_sha256")
	if err != nil {
		return RTCOffer{}, err
	}
	return RTCOffer{Version: version, RTCSessionID: sessionID, Generation: generation, Description: description, DescriptionSHA256: descriptionSHA256, DTLSFingerprintSHA256: fingerprint}, nil
}

func encodeRTCSignalingBody(value cborMapValue) ([]byte, error) {
	encoded, err := encodeCbor(value)
	if err != nil || len(encoded) == 0 || len(encoded) > MaxApplicationControlBodyBytes {
		return nil, ErrInvalidRTCSignaling
	}
	return encoded, nil
}

func decodeRTCSignalingMap(data []byte, label string, fields []string) (cborMapValue, error) {
	if len(data) == 0 || len(data) > MaxApplicationControlBodyBytes {
		return cborMapValue{}, ErrInvalidRTCSignaling
	}
	value, err := decodeDeterministicCBORWithTextLimit(data, MaxRTCDescriptionBytes)
	if err != nil {
		return cborMapValue{}, rtcError(err)
	}
	mapValue, err := cborMap(value, label)
	if err != nil {
		return cborMapValue{}, rtcError(err)
	}
	if err := cborRejectUnknown(mapValue, fields); err != nil {
		return cborMapValue{}, rtcError(err)
	}
	return mapValue, nil
}

func rtcVersion(mapValue cborMapValue) (string, error) {
	version, err := cborText(mapValue, "version")
	if err != nil || version != RTCSignalingVersion {
		return "", ErrInvalidRTCSignaling
	}
	return version, nil
}

func rtcSessionID(mapValue cborMapValue) ([]byte, error) {
	value, err := cborBytes(mapValue, "rtc_session_id", 16)
	if err != nil {
		return nil, rtcError(err)
	}
	return value, nil
}

func rtcGeneration(mapValue cborMapValue) (uint64, error) {
	value, err := cborUint(mapValue, "generation")
	if err != nil || value > MaxRTCGeneration {
		return 0, ErrInvalidRTCSignaling
	}
	return value, nil
}

func rtcHash(mapValue cborMapValue, key string) ([]byte, error) {
	value, err := cborBytes(mapValue, key, sha256.Size)
	if err != nil {
		return nil, rtcError(err)
	}
	return value, nil
}

func rtcCandidateDirection(mapValue cborMapValue) (RTCCandidateDirection, error) {
	value, err := cborText(mapValue, "direction")
	if err != nil || value != string(RTCCandidateDirectionOfferer) && value != string(RTCCandidateDirectionAnswerer) {
		return "", ErrInvalidRTCSignaling
	}
	return RTCCandidateDirection(value), nil
}

func rtcText(mapValue cborMapValue, key string, maximum int) (string, error) {
	value, err := cborRequired(mapValue, key)
	if err != nil {
		return "", rtcError(err)
	}
	text, ok := value.(string)
	if !ok || !validRTCText(text, maximum) {
		return "", ErrInvalidRTCSignaling
	}
	return text, nil
}

func validateRTCSession(version string, sessionID []byte, generation uint64) error {
	if version != RTCSignalingVersion || len(sessionID) != 16 || generation > MaxRTCGeneration {
		return ErrInvalidRTCSignaling
	}
	return nil
}

func validateRTCDescription(version string, sessionID []byte, generation uint64, description string, descriptionSHA256, fingerprint []byte) error {
	if err := validateRTCSession(version, sessionID, generation); err != nil {
		return err
	}
	if !validRTCText(description, MaxRTCDescriptionBytes) || len(descriptionSHA256) != sha256.Size || len(fingerprint) != sha256.Size {
		return ErrInvalidRTCSignaling
	}
	digest := sha256.Sum256([]byte(description))
	if string(descriptionSHA256) != string(digest[:]) {
		return ErrInvalidRTCSignaling
	}
	return nil
}

func validRTCText(value string, maximum int) bool {
	return utf8.ValidString(value) && len([]byte(value)) > 0 && len([]byte(value)) <= maximum
}

func rtcError(err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%w: %v", ErrInvalidRTCSignaling, err)
}
