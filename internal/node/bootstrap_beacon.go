package node

import (
	"time"

	"github.com/code4bones/branch/internal/admin"
	"github.com/code4bones/branch/internal/identity"
	protocol "github.com/code4bones/branch/protocol/v0"
)

type bootstrapBeaconProvider struct {
	identity *identity.NodeIdentity
	now      func() time.Time
}

func newBootstrapBeaconProvider(nodeIdentity *identity.NodeIdentity) *bootstrapBeaconProvider {
	return &bootstrapBeaconProvider{
		identity: nodeIdentity,
		now:      time.Now,
	}
}

func (provider *bootstrapBeaconProvider) BootstrapBeacon(request admin.BootstrapBeaconRequest) (admin.BootstrapBeaconResponse, error) {
	now := provider.now().Unix()
	expiresAt := now + int64(protocol.DefaultBootstrapLifetime.Seconds())
	endpoints := append([]protocol.BootstrapRelayEndpoint(nil), request.RelayEndpoints...)
	wrapper, err := protocol.CreateBootstrapBeaconWrapper(protocol.BootstrapBeaconOptions{
		NowUnix:            now,
		ExpiresAtUnix:      expiresAt,
		Sequence:           1,
		SenderPublicKey:    provider.identity.PublicKey(),
		RelayEndpoints:     endpoints,
		ProtocolVersions:   []string{protocol.ProtocolID},
		ProfileMultihashes: []string{protocol.DevelopmentProfileMultihash},
		RelayCapabilities:  []string{"relay.federate.live/0.draft", "relay.forward.live/0", "route.relay.wss/0"},
		Sign: func(message []byte) ([]byte, error) {
			return provider.identity.Sign(message), nil
		},
	})
	if err != nil {
		return admin.BootstrapBeaconResponse{}, err
	}
	return admin.BootstrapBeaconResponse{
		Wrapper:          wrapper,
		RelayPublicKey:   provider.identity.PublicKeyString(),
		Protocol:         protocol.ProtocolID,
		ProfileMultihash: protocol.DevelopmentProfileMultihash,
		ExpiresAt:        expiresAt,
		RelayEndpoints:   endpoints,
	}, nil
}
