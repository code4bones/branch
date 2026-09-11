package v0

import (
	"bytes"
	"errors"
	"fmt"
	"unicode/utf8"
)

const (
	maxDecodedCBOREntries = 64
	maxDecodedCBORBytes   = 48 * 1024

	// MaxDeterministicCBORNestingDepth is the maximum number of array/map
	// containers on one decoded CBOR path. The outermost array or map is depth
	// one. It is a wire-level bound shared by every deterministic-CBOR body so
	// hostile input cannot create unbounded parser recursion.
	MaxDeterministicCBORNestingDepth = 8
)

var (
	errInvalidCBOR      = errors.New("invalid cbor")
	errNonCanonicalCBOR = errors.New("non-canonical cbor")
)

func decodeDeterministicCBOR(input []byte) (any, error) {
	return decodeDeterministicCBORWithTextLimit(input, MaxDraftStringBytes)
}

// decodeDeterministicCBORWithTextLimit retains the shared deterministic-CBOR
// checks while allowing a protocol body to declare a tighter or wider text
// bound than the historical draft envelope fields. Callers must still apply
// their field-specific bounds after decoding.
func decodeDeterministicCBORWithTextLimit(input []byte, maxTextBytes int) (any, error) {
	if len(input) == 0 || len(input) > MaxDraftEnvelopeBytes {
		return nil, errInvalidCBOR
	}
	if maxTextBytes <= 0 || maxTextBytes > maxDecodedCBORBytes {
		return nil, errInvalidCBOR
	}
	decoder := cborDecoder{input: input, maxTextBytes: maxTextBytes}
	value, err := decoder.readValue(0)
	if err != nil {
		return nil, err
	}
	if decoder.offset != len(input) {
		return nil, errInvalidCBOR
	}
	encoded, err := encodeCbor(value)
	if err != nil {
		return nil, errInvalidCBOR
	}
	if !bytes.Equal(encoded, input) {
		return nil, errNonCanonicalCBOR
	}
	return value, nil
}

type cborDecoder struct {
	input        []byte
	offset       int
	maxTextBytes int
}

func (decoder *cborDecoder) readValue(nestingDepth int) (any, error) {
	initial, err := decoder.readByte()
	if err != nil {
		return nil, err
	}
	major := initial >> 5
	additional := initial & 0x1f
	if major == 7 {
		switch additional {
		case 20:
			return false, nil
		case 21:
			return true, nil
		default:
			return nil, errInvalidCBOR
		}
	}
	argument, err := decoder.readArgument(additional)
	if err != nil {
		return nil, err
	}

	switch major {
	case 0:
		return argument, nil
	case 2:
		return decoder.readByteString(argument)
	case 3:
		return decoder.readTextString(argument)
	case 4:
		if nestingDepth >= MaxDeterministicCBORNestingDepth {
			return nil, errInvalidCBOR
		}
		return decoder.readArray(argument, nestingDepth+1)
	case 5:
		if nestingDepth >= MaxDeterministicCBORNestingDepth {
			return nil, errInvalidCBOR
		}
		return decoder.readMap(argument, nestingDepth+1)
	default:
		return nil, errInvalidCBOR
	}
}

func (decoder *cborDecoder) readArgument(additional byte) (uint64, error) {
	switch {
	case additional < 24:
		return uint64(additional), nil
	case additional == 24:
		value, err := decoder.readByte()
		if err != nil {
			return 0, err
		}
		if value < 24 {
			return 0, errNonCanonicalCBOR
		}
		return uint64(value), nil
	case additional == 25:
		value, err := decoder.readUint(2)
		if err != nil {
			return 0, err
		}
		if value <= 0xff {
			return 0, errNonCanonicalCBOR
		}
		return value, nil
	case additional == 26:
		value, err := decoder.readUint(4)
		if err != nil {
			return 0, err
		}
		if value <= 0xffff {
			return 0, errNonCanonicalCBOR
		}
		return value, nil
	case additional == 27:
		value, err := decoder.readUint(8)
		if err != nil {
			return 0, err
		}
		if value <= 0xffffffff {
			return 0, errNonCanonicalCBOR
		}
		return value, nil
	default:
		return 0, errInvalidCBOR
	}
}

func (decoder *cborDecoder) readByteString(size uint64) ([]byte, error) {
	if size > maxDecodedCBORBytes {
		return nil, errInvalidCBOR
	}
	data, err := decoder.readBytes(size)
	if err != nil {
		return nil, err
	}
	return append([]byte(nil), data...), nil
}

func (decoder *cborDecoder) readTextString(size uint64) (string, error) {
	if size == 0 || size > uint64(decoder.maxTextBytes) {
		return "", errInvalidCBOR
	}
	data, err := decoder.readBytes(size)
	if err != nil {
		return "", err
	}
	if !utf8.Valid(data) {
		return "", errInvalidCBOR
	}
	return string(data), nil
}

func (decoder *cborDecoder) readArray(size uint64, nestingDepth int) (cborArrayValue, error) {
	if size > maxDecodedCBOREntries {
		return cborArrayValue{}, errInvalidCBOR
	}
	values := make([]any, 0, int(size))
	for range size {
		value, err := decoder.readValue(nestingDepth)
		if err != nil {
			return cborArrayValue{}, err
		}
		values = append(values, value)
	}
	return cborArrayValue{values: values}, nil
}

func (decoder *cborDecoder) readMap(size uint64, nestingDepth int) (cborMapValue, error) {
	if size > maxDecodedCBOREntries {
		return cborMapValue{}, errInvalidCBOR
	}
	entries := make([]cborEntry, 0, int(size))
	seen := make(map[string]struct{}, int(size))
	var previousKey []byte
	for range size {
		keyOffset := decoder.offset
		keyValue, err := decoder.readValue(nestingDepth)
		if err != nil {
			return cborMapValue{}, err
		}
		key, ok := keyValue.(string)
		if !ok {
			return cborMapValue{}, errInvalidCBOR
		}
		if _, ok := seen[key]; ok {
			return cborMapValue{}, errInvalidCBOR
		}
		seen[key] = struct{}{}
		encodedKey := decoder.input[keyOffset:decoder.offset]
		if previousKey != nil && bytes.Compare(previousKey, encodedKey) >= 0 {
			return cborMapValue{}, errNonCanonicalCBOR
		}
		previousKey = append(previousKey[:0], encodedKey...)

		value, err := decoder.readValue(nestingDepth)
		if err != nil {
			return cborMapValue{}, err
		}
		entries = append(entries, cborEntry{key: key, value: value})
	}
	return cborMapValue{entries: entries}, nil
}

func (decoder *cborDecoder) readUint(size int) (uint64, error) {
	data, err := decoder.readBytes(uint64(size))
	if err != nil {
		return 0, err
	}
	var value uint64
	for _, item := range data {
		value = (value << 8) | uint64(item)
	}
	return value, nil
}

func (decoder *cborDecoder) readByte() (byte, error) {
	data, err := decoder.readBytes(1)
	if err != nil {
		return 0, err
	}
	return data[0], nil
}

func (decoder *cborDecoder) readBytes(size uint64) ([]byte, error) {
	if size > uint64(len(decoder.input)-decoder.offset) {
		return nil, errInvalidCBOR
	}
	start := decoder.offset
	decoder.offset += int(size)
	return decoder.input[start:decoder.offset], nil
}

func cborMap(value any, label string) (cborMapValue, error) {
	mapValue, ok := value.(cborMapValue)
	if !ok {
		return cborMapValue{}, fmt.Errorf("missing_%s", label)
	}
	return mapValue, nil
}

func cborRequired(mapValue cborMapValue, key string) (any, error) {
	for _, entry := range mapValue.entries {
		if entry.key == key {
			return entry.value, nil
		}
	}
	return nil, fmt.Errorf("missing_%s", key)
}

func cborHas(mapValue cborMapValue, key string) bool {
	for _, entry := range mapValue.entries {
		if entry.key == key {
			return true
		}
	}
	return false
}

func cborRejectUnknown(mapValue cborMapValue, known []string) error {
	allowed := make(map[string]struct{}, len(known))
	for _, key := range known {
		allowed[key] = struct{}{}
	}
	for _, entry := range mapValue.entries {
		if _, ok := allowed[entry.key]; !ok {
			return fmt.Errorf("unknown_%s", entry.key)
		}
	}
	return nil
}

func cborText(mapValue cborMapValue, key string) (string, error) {
	value, err := cborRequired(mapValue, key)
	if err != nil {
		return "", err
	}
	text, ok := value.(string)
	if !ok || text == "" || len([]byte(text)) > MaxDraftStringBytes {
		return "", fmt.Errorf("invalid_%s", key)
	}
	return text, nil
}

func cborUint(mapValue cborMapValue, key string) (uint64, error) {
	value, err := cborRequired(mapValue, key)
	if err != nil {
		return 0, err
	}
	number, ok := value.(uint64)
	if !ok || number > MaxDraftTimestamp {
		return 0, fmt.Errorf("invalid_%s", key)
	}
	return number, nil
}

func cborBool(mapValue cborMapValue, key string) (bool, error) {
	value, err := cborRequired(mapValue, key)
	if err != nil {
		return false, err
	}
	boolean, ok := value.(bool)
	if !ok {
		return false, fmt.Errorf("invalid_%s", key)
	}
	return boolean, nil
}

func cborBytes(mapValue cborMapValue, key string, size int) ([]byte, error) {
	value, err := cborRequired(mapValue, key)
	if err != nil {
		return nil, err
	}
	bytesValue, ok := value.([]byte)
	if !ok || len(bytesValue) == 0 || len(bytesValue) > maxDecodedCBORBytes {
		return nil, fmt.Errorf("invalid_%s", key)
	}
	if size > 0 && len(bytesValue) != size {
		return nil, fmt.Errorf("invalid_%s", key)
	}
	return append([]byte(nil), bytesValue...), nil
}
