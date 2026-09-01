package admin

import (
	"fmt"
	"net/url"

	protocol "github.com/code4bones/branch/protocol/v0"
)

type BootstrapBeaconRequest struct {
	RelayEndpoints []protocol.BootstrapRelayEndpoint
}

type BootstrapBeaconResponse struct {
	Wrapper          string                            `json:"wrapper"`
	RelayPublicKey   string                            `json:"relay_public_key"`
	Protocol         string                            `json:"protocol"`
	ProfileMultihash string                            `json:"profile_multihash"`
	ExpiresAt        int64                             `json:"expires_at"`
	RelayEndpoints   []protocol.BootstrapRelayEndpoint `json:"relay_endpoints"`
}

type BootstrapBeaconProvider interface {
	BootstrapBeacon(BootstrapBeaconRequest) (BootstrapBeaconResponse, error)
}

func ParseBootstrapBeaconRequest(values url.Values) (BootstrapBeaconRequest, error) {
	rawEndpoints := values["endpoint"]
	if len(rawEndpoints) == 0 {
		return BootstrapBeaconRequest{}, fmt.Errorf("missing endpoint")
	}
	if len(rawEndpoints) > protocol.MaxBootstrapEndpoints {
		return BootstrapBeaconRequest{}, fmt.Errorf("too many endpoints")
	}

	endpoints := make([]protocol.BootstrapRelayEndpoint, 0, len(rawEndpoints))
	for index, rawEndpoint := range rawEndpoints {
		endpoints = append(endpoints, protocol.BootstrapRelayEndpoint{
			Transport: "wss",
			URI:       rawEndpoint,
			Priority:  uint64(index),
		})
	}
	return BootstrapBeaconRequest{RelayEndpoints: endpoints}, nil
}
