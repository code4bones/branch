import {
  betaHpkeCiphertextBytesForPlaintext,
  developmentProfileMultihash,
  encodeBase64URL,
  makeBetaPayloadAAD,
  protocolID,
  sealBetaPayload
} from "@code4bones/branch-core";

import { fixedAckRequested, fixedPathEpoch, fixedStreamId } from "./payload-aad-defaults.js";
import { encodeChatTextApplicationPayload } from "./application-payload.js";
import { encodeBetaPwaMessagePayload, encodeBetaPwaPresencePing, encodeBetaPwaPresencePong } from "./message-payload.js";
import { clearDelivery, getRelaySessionClient, trackDelivery } from "./relay-session.js";

const liveRouteIDs = new WeakMap<object, Map<string, string>>();
const maxLiveRoutesPerAttachment = 64;

export interface SealAndSendOptions {
  readonly deliveryId?: string;
  readonly senderPeerId: string;
  readonly senderHpkePublicKey: string;
  readonly senderDisplayName: string;
  readonly recipientPeerId: string;
  readonly recipientHpkePublicKey: string;
  readonly contactId: string;
  readonly onRelayOutcomeTimeout: () => void;
  readonly plaintext: string;
}

export interface PresenceControlOptions {
  readonly senderPeerId: string;
  readonly recipientPeerId: string;
  readonly recipientHpkePublicKey: string;
  readonly pingId: string;
}

// Seals a visible user message and tracks only its relay-forward outcome.
// Control envelopes use the same HPKE boundary but deliberately have no
// message-log state and no delivery claim.
export async function sealAndSendMessage(options: SealAndSendOptions): Promise<string> {
  const deliveryId = options.deliveryId ?? createDeliveryID();
  await sealAndSendPayload({
    senderPeerId: options.senderPeerId,
    recipientPeerId: options.recipientPeerId,
    recipientHpkePublicKey: options.recipientHpkePublicKey,
    deliveryId,
    plaintext: encodeBetaPwaMessagePayload({
      body: options.plaintext,
      replyHpkePublicKey: options.senderHpkePublicKey,
      senderDisplayName: options.senderDisplayName
    }),
    track: { contactId: options.contactId, onTimeout: options.onRelayOutcomeTimeout }
  });
  return deliveryId;
}

// Sends the registered generic text kind as exact deterministic-CBOR bytes
// inside the existing HPKE boundary. Its application message id is deliberately
// independent of the live relay delivery id.
export async function sealAndSendApplicationTextMessage(options: Omit<SealAndSendOptions, "senderHpkePublicKey" | "senderDisplayName">): Promise<string> {
  const deliveryId = options.deliveryId ?? createDeliveryID();
  await sealAndSendPayload({
    senderPeerId: options.senderPeerId,
    recipientPeerId: options.recipientPeerId,
    recipientHpkePublicKey: options.recipientHpkePublicKey,
    deliveryId,
    plaintext: encodeChatTextApplicationPayload({
      messageId: createDeliveryID(),
      body: options.plaintext
    }),
    track: { contactId: options.contactId, onTimeout: options.onRelayOutcomeTimeout }
  });
  return deliveryId;
}

export async function sendPresencePing(options: Omit<PresenceControlOptions, "pingId"> & { readonly pingId?: string }): Promise<string> {
  const pingId = options.pingId ?? createDeliveryID();
  await sealAndSendPayload({
    senderPeerId: options.senderPeerId,
    recipientPeerId: options.recipientPeerId,
    recipientHpkePublicKey: options.recipientHpkePublicKey,
    deliveryId: createDeliveryID(),
    plaintext: encodeBetaPwaPresencePing(pingId)
  });
  return pingId;
}

export async function sendPresencePong(options: PresenceControlOptions): Promise<void> {
  await sealAndSendPayload({
    senderPeerId: options.senderPeerId,
    recipientPeerId: options.recipientPeerId,
    recipientHpkePublicKey: options.recipientHpkePublicKey,
    deliveryId: createDeliveryID(),
    plaintext: encodeBetaPwaPresencePong(options.pingId)
  });
}

export async function sendApplicationControl(options: {
  readonly senderPeerId: string;
  readonly recipientPeerId: string;
  readonly recipientHpkePublicKey: string;
  readonly plaintext: Uint8Array;
}): Promise<void> {
  await sealAndSendPayload({
    senderPeerId: options.senderPeerId,
    recipientPeerId: options.recipientPeerId,
    recipientHpkePublicKey: options.recipientHpkePublicKey,
    deliveryId: createDeliveryID(),
    plaintext: options.plaintext
  });
}

// Framework-free endpoint adapter for a registered binary application kind.
// It has no message-log tracking, relay queue, retry, or durable delivery claim.
export async function sendApplicationPayload(options: {
  readonly senderPeerId: string;
  readonly recipientPeerId: string;
  readonly recipientHpkePublicKey: string;
  readonly deliveryId: string;
  readonly plaintext: Uint8Array;
}): Promise<void> {
  await sealAndSendPayload(options);
}

interface SealPayloadOptions {
  readonly senderPeerId: string;
  readonly recipientPeerId: string;
  readonly recipientHpkePublicKey: string;
  readonly deliveryId: string;
  readonly plaintext: string | Uint8Array;
  readonly track?: { readonly contactId: string; readonly onTimeout: () => void };
}

async function sealAndSendPayload(options: SealPayloadOptions): Promise<void> {
  const client = getRelaySessionClient();
  if (client === null || client.routeId === null) {
    throw new Error("relay session is not attached");
  }
  const originRouteId = client.routeId;
  const expectedCiphertextBytes = betaHpkeCiphertextBytesForPlaintext(options.plaintext);
  const aad = makeBetaPayloadAAD({
    protocol: protocolID,
    profileMultihash: developmentProfileMultihash,
    originRouteId,
    senderPeerKey: options.senderPeerId,
    recipientPeerKey: options.recipientPeerId,
    deliveryId: options.deliveryId,
    pathEpoch: fixedPathEpoch,
    streamId: fixedStreamId,
    frameType: "ENVELOPE",
    ackRequested: fixedAckRequested,
    hpkeCiphertextBytes: expectedCiphertextBytes
  });
  const sealed = await sealBetaPayload({
    recipientPublicKey: options.recipientHpkePublicKey,
    plaintext: options.plaintext,
    aad,
    expectedCiphertextBytes
  });
  // READY.route_id is an E2EE origin nonce, not a relay lookup key. Each
  // reachable contact receives one distinct, tab-volatile lookup route so
  // concurrent conversations cannot overwrite one another's live binding.
  const routeId = liveRouteID(client, options.recipientPeerId);
  client.rendezvous(options.recipientPeerId, { routeId });
  if (options.track !== undefined) {
    trackDelivery(options.deliveryId, options.track.contactId, options.track.onTimeout);
  }
  try {
    client.sendSealedEnvelope(sealed, { deliveryId: options.deliveryId, routeId, originRouteId, ackRequested: fixedAckRequested });
  } catch (cause) {
    clearDelivery(options.deliveryId);
    throw cause;
  }
}

function liveRouteID(client: object, peerId: string): string {
  let routes = liveRouteIDs.get(client);
  if (routes === undefined) {
    routes = new Map<string, string>();
    liveRouteIDs.set(client, routes);
  }
  const existing = routes.get(peerId);
  if (existing !== undefined) {
    return existing;
  }
  if (routes.size >= maxLiveRoutesPerAttachment) {
    throw new Error("live contact route limit reached");
  }
  const routeId = createDeliveryID();
  routes.set(peerId, routeId);
  return routeId;
}

export function createDeliveryID(
  fillRandomBytes: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes)
): string {
  const bytes = new Uint8Array(16);
  return encodeBase64URL(fillRandomBytes(bytes));
}
