// Fixed AAD conventions for the online-only same-relay slice (D-BRANCH-034).
// makeBetaPayloadAAD binds path_epoch/stream_id/ack_requested into the
// authenticated data. SameRelayTransportClient fixes these values internally,
// so both seal and open sides use the same fixed values rather than guessing
// at frame metadata the client cannot observe. origin_route_id is not fixed:
// it comes from READY on seal and the delivered ENVELOPE on open.
export const fixedPathEpoch = 0;
export const fixedStreamId = 0;
export const fixedAckRequested = true;
