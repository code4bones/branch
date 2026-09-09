import {
  betaHpkeCiphertextBytesFromSealedPayload,
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

// Opens an incoming human-to-human ENVELOPE without assigning a text encoding
// to its plaintext. New application/control envelopes are canonical CBOR bytes;
// the incoming adapter owns the explicit legacy UTF-8 compatibility branch.
export async function openIncomingEnvelope(options: OpenEnvelopeOptions): Promise<Uint8Array> {
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
  return plaintext;
}
