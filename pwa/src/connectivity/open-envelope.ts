import {
  betaHpkeCiphertextBytesFromSealedPayload,
  decodeBetaPayloadText,
  developmentProfileMultihash,
  makeBetaPayloadAAD,
  openBetaPayload,
  protocolID
} from "@code4bones/branch-core";

import { fixedAckRequested, fixedPathEpoch, fixedStreamId } from "./payload-aad-defaults.js";

export interface OpenEnvelopeOptions {
  readonly senderPeerId: string;
  readonly recipientPeerId: string;
  readonly originRouteId: string;
  readonly recipientHpkePrivateKey: CryptoKey;
  readonly deliveryId: string;
  readonly sealedPayload: string;
}

// Opens an incoming human-to-human ENVELOPE (plain UTF-8 text body). Echo
// replies use a different shape — see src/connectivity/echo-protocol.ts.
export async function openIncomingEnvelope(options: OpenEnvelopeOptions): Promise<string> {
  const expectedCiphertextBytes = betaHpkeCiphertextBytesFromSealedPayload(options.sealedPayload);
  const aad = makeBetaPayloadAAD({
    protocol: protocolID,
    profileMultihash: developmentProfileMultihash,
    originRouteId: options.originRouteId,
    senderPeerKey: options.senderPeerId,
    recipientPeerKey: options.recipientPeerId,
    deliveryId: options.deliveryId,
    pathEpoch: fixedPathEpoch,
    streamId: fixedStreamId,
    frameType: "ENVELOPE",
    ackRequested: fixedAckRequested,
    hpkeCiphertextBytes: expectedCiphertextBytes
  });
  const plaintext = await openBetaPayload({
    recipientPrivateKey: options.recipientHpkePrivateKey,
    sealedPayload: options.sealedPayload,
    aad,
    expectedCiphertextBytes
  });
  return decodeBetaPayloadText(plaintext);
}
