package v0

import (
	"errors"
	"testing"
)

func TestDecodeDeterministicCBORBoundsContainerNesting(t *testing.T) {
	tests := []struct {
		name  string
		value any
		valid bool
	}{
		{
			name:  "arrays at maximum nesting",
			value: nestedCBORArray(MaxDeterministicCBORNestingDepth),
			valid: true,
		},
		{
			name:  "arrays beyond maximum nesting",
			value: nestedCBORArray(MaxDeterministicCBORNestingDepth + 1),
			valid: false,
		},
		{
			name:  "maps at maximum nesting",
			value: nestedCBORMap(MaxDeterministicCBORNestingDepth),
			valid: true,
		},
		{
			name:  "maps beyond maximum nesting",
			value: nestedCBORMap(MaxDeterministicCBORNestingDepth + 1),
			valid: false,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			encoded, err := encodeCbor(test.value)
			if err != nil {
				t.Fatalf("encode deterministic CBOR: %v", err)
			}

			_, err = decodeDeterministicCBOR(encoded)
			if test.valid {
				if err != nil {
					t.Fatalf("decode nesting depth %d: %v", MaxDeterministicCBORNestingDepth, err)
				}
				return
			}
			if !errors.Is(err, errInvalidCBOR) {
				t.Fatalf("decode nesting depth %d error = %v, want invalid CBOR", MaxDeterministicCBORNestingDepth+1, err)
			}
		})
	}
}

func nestedCBORArray(depth int) any {
	value := any(false)
	for range depth {
		value = cborArrayValue{values: []any{value}}
	}
	return value
}

func nestedCBORMap(depth int) any {
	value := any(false)
	for range depth {
		value = cborMapValue{entries: []cborEntry{{key: "a", value: value}}}
	}
	return value
}
