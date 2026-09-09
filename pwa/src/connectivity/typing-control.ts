import {
  applicationControlSigningBytes,
  createApplicationControlRegistry,
  decodeBase64URL,
  encodeApplicationControl,
  encodeBase64URL,
  prepareOutboundApplicationControl,
  processApplicationControl,
  type ApplicationControlDescriptor,
  type ApplicationControlRejection
} from "@code4bones/branch-core";

import { getLocalIdentityKeys } from "../identity/identity-keys.js";
import { createDeliveryID, sendApplicationControl } from "./seal-and-send.js";

export const typingControlKind = "branch.pwa.typing/0.draft";
export const typingControlPayloadPrefix = "BRANCH-APPLICATION-CONTROL0.";
export const typingControlTTLms = 6_000;
const typingRenewIntervalMs = 2_000;
const maxTypingRateEntries = 64;
const replayControlIds = new Map<string, number>();
const lastTypingSentAtByPeerId = new Map<string, number>();

export type TypingControlOutcome = "accepted" | ApplicationControlRejection | "projection_missing";

export interface ReceivedTypingControl {
  readonly handled: boolean;
  readonly outcome?: TypingControlOutcome;
  readonly contactId?: string;
  readonly expiresAt?: number;
}

export type TypingControlSendResult = "sent" | "skipped";

const typingDescriptor: ApplicationControlDescriptor<{ readonly active: true }> = {
  kind: typingControlKind,
  authentication: "ed25519",
  maximumTTLms: typingControlTTLms,
  projection: "ephemeral",
  allowedEffects: ["ephemeral_projection"],
  decodeBody: (body) => {
    if (body.byteLength !== 1 || body[0] !== 1) {
      throw new Error("invalid typing body");
    }
    return { active: true };
  },
  encodeBody: () => new Uint8Array([1]),
  reduce: ({ envelope }) => [{
    kind: "ephemeral_projection",
    projection: "typing",
    value: new Uint8Array([1]),
    expiresAt: envelope.expiresAt
  }]
};

const typingRegistry = createApplicationControlRegistry([typingDescriptor]);

export async function sendTypingControl(options: {
  readonly senderPeerId: string;
  readonly recipientPeerId: string;
  readonly recipientHpkePublicKey: string;
  readonly attached: boolean;
}): Promise<TypingControlSendResult> {
  if (!options.attached) {
    return "skipped";
  }
  const keys = getLocalIdentityKeys();
  if (keys === null) {
    return "skipped";
  }
  const now = Date.now();
  let unsigned: ReturnType<typeof prepareOutboundApplicationControl<{ readonly active: true }>>;
  try {
    unsigned = prepareOutboundApplicationControl({
      kind: typingControlKind,
      controlId: createDeliveryID(),
      issuedAt: now,
      expiresAt: now + typingControlTTLms,
      senderPeerId: options.senderPeerId,
      recipientPeerId: options.recipientPeerId,
      body: { active: true }
    }, typingDescriptor, {
      now,
      localPeerId: options.senderPeerId,
      isKnownContact: (peerId) => peerId === options.recipientPeerId,
      isAllowed: () => true,
      consumeRateLimit: (_kind, peerId, at) => consumeTypingRate(peerId, at),
      maxClockSkewMs: 1_000
    });
  } catch (cause) {
    if (cause instanceof Error && cause.message === "application control rate limited") {
      return "skipped";
    }
    throw cause;
  }
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", keys.relayPrivateKey, toArrayBuffer(applicationControlSigningBytes(unsigned))));
  const payload = typingControlPayloadPrefix + encodeBase64URL(encodeApplicationControl({ ...unsigned, signature }));
  await sendApplicationControl({
    senderPeerId: options.senderPeerId,
    recipientPeerId: options.recipientPeerId,
    recipientHpkePublicKey: options.recipientHpkePublicKey,
    plaintext: payload
  });
  return "sent";
}

export async function receiveTypingControl(options: {
  readonly plaintext: string;
  readonly localPeerId: string;
  readonly senderPeerId: string;
  readonly knownContactId: string | null;
}): Promise<ReceivedTypingControl> {
  if (!options.plaintext.startsWith(typingControlPayloadPrefix)) {
    return { handled: false };
  }
  const now = Date.now();
  pruneReplayWindow(now);
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64URL(options.plaintext.slice(typingControlPayloadPrefix.length));
  } catch {
    return { handled: true, outcome: "malformed" };
  }
  const result = await processApplicationControl(bytes, typingRegistry, {
    now,
    localPeerId: options.localPeerId,
    isKnownContact: (peerId) => options.knownContactId !== null && peerId === options.senderPeerId,
    verifyEd25519: verifyControlSignature,
    hasSeenControl: (controlId) => replayControlIds.has(controlId),
    rememberControl: (controlId, expiresAt) => { replayControlIds.set(controlId, expiresAt); },
    isAllowed: () => true,
    maxClockSkewMs: 1_000
  });
  if (result.status !== "accepted") {
    return { handled: true, outcome: result.reason };
  }
  if (options.knownContactId === null) {
    return { handled: true, outcome: "unknown_contact" };
  }
  const effect = result.effects.find((candidate) => candidate.kind === "ephemeral_projection" && candidate.projection === "typing");
  return effect?.kind === "ephemeral_projection"
    ? { handled: true, outcome: "accepted", contactId: options.knownContactId, expiresAt: effect.expiresAt }
    : { handled: true, outcome: "projection_missing" };
}

function consumeTypingRate(peerId: string, now: number): boolean {
  // A typing renewal is useful only within its short send interval. Keep this
  // adapter-local anti-chatter map explicitly bounded and volatile.
  for (const [candidatePeerId, sentAt] of lastTypingSentAtByPeerId) {
    if (now - sentAt >= typingRenewIntervalMs) {
      lastTypingSentAtByPeerId.delete(candidatePeerId);
    }
  }
  const last = lastTypingSentAtByPeerId.get(peerId) ?? 0;
  if (now - last < typingRenewIntervalMs) {
    return false;
  }
  if (!lastTypingSentAtByPeerId.has(peerId) && lastTypingSentAtByPeerId.size >= maxTypingRateEntries) {
    const oldestPeerId = lastTypingSentAtByPeerId.keys().next().value;
    if (oldestPeerId !== undefined) {
      lastTypingSentAtByPeerId.delete(oldestPeerId);
    }
  }
  lastTypingSentAtByPeerId.set(peerId, now);
  return true;
}

function pruneReplayWindow(now: number): void {
  for (const [controlId, expiresAt] of replayControlIds) {
    if (expiresAt <= now) {
      replayControlIds.delete(controlId);
    }
  }
  while (replayControlIds.size > 128) {
    const oldest = replayControlIds.keys().next().value;
    if (oldest === undefined) {
      return;
    }
    replayControlIds.delete(oldest);
  }
}

async function verifyControlSignature(peerId: string, input: Uint8Array, signature: Uint8Array): Promise<boolean> {
  try {
    const publicKey = await crypto.subtle.importKey("raw", toArrayBuffer(decodeBase64URL(peerId)), "Ed25519", false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", publicKey, toArrayBuffer(signature), toArrayBuffer(input));
  } catch {
    return false;
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}
