package v0

import (
	"errors"
	"fmt"
	"unicode/utf8"
)

const (
	// ContactCardControlKind is an endpoint-only signed application-control
	// descriptor. Its body never becomes relay metadata.
	ContactCardControlKind  = "branch.contact-card/0.draft"
	MaxContactCardBytes     = 512
	MaxContactCardNameBytes = 96
	MaxContactCardTTLMillis = 60 * 1000
)

var ErrInvalidContactCard = errors.New("invalid contact card")

// ContactCard is the deterministic-CBOR body delivered inside an existing
// HPKE-protected application-control envelope. It is merely a candidate: the
// adapter binds it to one pending lookup and requires explicit user Add.
type ContactCard struct {
	RequestID     []byte
	BranchID      string
	PeerID        []byte
	HPKEPublicKey []byte
	DisplayName   string
}

func EncodeContactCard(card ContactCard) ([]byte, error) {
	if err := card.Validate(); err != nil {
		return nil, err
	}
	encoded, err := encodeCbor(contactCardMap(card))
	if err != nil || len(encoded) > MaxContactCardBytes {
		return nil, ErrInvalidContactCard
	}
	return encoded, nil
}

func DecodeContactCard(data []byte) (ContactCard, error) {
	if len(data) == 0 || len(data) > MaxContactCardBytes {
		return ContactCard{}, ErrInvalidContactCard
	}
	value, err := decodeDeterministicCBOR(data)
	if err != nil {
		return ContactCard{}, fmt.Errorf("%w: %v", ErrInvalidContactCard, err)
	}
	mapValue, err := cborMap(value, "contact_card")
	if err != nil {
		return ContactCard{}, fmt.Errorf("%w: %v", ErrInvalidContactCard, err)
	}
	if err := cborRejectUnknown(mapValue, []string{"request_id", "branch_id", "peer_id", "hpke_public_key", "display_name"}); err != nil {
		return ContactCard{}, fmt.Errorf("%w: %v", ErrInvalidContactCard, err)
	}
	requestID, err := cborBytes(mapValue, "request_id", 16)
	if err != nil {
		return ContactCard{}, fmt.Errorf("%w: %v", ErrInvalidContactCard, err)
	}
	branchID, err := cborText(mapValue, "branch_id")
	if err != nil || ParseBranchID(branchID) != nil {
		return ContactCard{}, ErrInvalidContactCard
	}
	peerID, err := cborBytes(mapValue, "peer_id", 32)
	if err != nil {
		return ContactCard{}, fmt.Errorf("%w: %v", ErrInvalidContactCard, err)
	}
	hpkePublicKey, err := cborBytes(mapValue, "hpke_public_key", 32)
	if err != nil {
		return ContactCard{}, fmt.Errorf("%w: %v", ErrInvalidContactCard, err)
	}
	displayName, err := cborText(mapValue, "display_name")
	if err != nil {
		return ContactCard{}, fmt.Errorf("%w: %v", ErrInvalidContactCard, err)
	}
	card := ContactCard{RequestID: requestID, BranchID: branchID, PeerID: peerID, HPKEPublicKey: hpkePublicKey, DisplayName: displayName}
	if err := card.Validate(); err != nil {
		return ContactCard{}, err
	}
	return card, nil
}

func (card ContactCard) Validate() error {
	if len(card.RequestID) != 16 || len(card.PeerID) != 32 || len(card.HPKEPublicKey) != 32 || !utf8.ValidString(card.DisplayName) || len(card.DisplayName) == 0 || len([]byte(card.DisplayName)) > MaxContactCardNameBytes || ParseBranchID(card.BranchID) != nil {
		return ErrInvalidContactCard
	}
	return nil
}

func contactCardMap(card ContactCard) cborMapValue {
	return cborMapValue{entries: []cborEntry{
		{key: "request_id", value: card.RequestID},
		{key: "branch_id", value: card.BranchID},
		{key: "peer_id", value: card.PeerID},
		{key: "hpke_public_key", value: card.HPKEPublicKey},
		{key: "display_name", value: card.DisplayName},
	}}
}
