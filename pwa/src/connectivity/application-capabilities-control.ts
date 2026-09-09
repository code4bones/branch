import {
  applicationCapabilitiesControlKind,
  applicationControlSigningBytes,
  createApplicationControlRegistry,
  decodeBase64URL,
  decodeApplicationCapabilities,
  decodeApplicationControl,
  encodeApplicationCapabilities,
  encodeApplicationControl,
  prepareOutboundApplicationControl,
  processApplicationControl,
  type ApplicationCapabilities,
  type ApplicationControlDescriptor,
  type ApplicationControlRejection
} from "@code4bones/branch-core";

import { getLocalIdentityKeys } from "../identity/identity-keys.js";
import { createDeliveryID, sendApplicationControl } from "./seal-and-send.js";

export const applicationCapabilitiesControlTTLms = 5 * 60_000;
const capabilityRenewIntervalMs = 30_000;
const maxCapabilityCacheEntries = 64;
const maxCapabilityReplayEntries = 128;

export type ApplicationCapabilitiesOutcome = "accepted" | ApplicationControlRejection;
export interface ReceivedApplicationCapabilities {
  readonly handled: boolean;
  readonly outcome?: ApplicationCapabilitiesOutcome;
  readonly capabilities?: ApplicationCapabilities;
  readonly expiresAt?: number;
}

export const applicationCapabilitiesControlDescriptor: ApplicationControlDescriptor<ApplicationCapabilities> = {
  kind: applicationCapabilitiesControlKind,
  authentication: "ed25519",
  maximumTTLms: applicationCapabilitiesControlTTLms,
  projection: "ephemeral",
  allowedEffects: ["ephemeral_projection"],
  decodeBody: decodeApplicationCapabilities,
  encodeBody: encodeApplicationCapabilities,
  reduce: ({ envelope, body }) => [{
    kind: "ephemeral_projection",
    projection: "application_capabilities",
    value: encodeApplicationCapabilities(body),
    expiresAt: envelope.expiresAt
  }]
};

const capabilityRegistry = createApplicationControlRegistry([applicationCapabilitiesControlDescriptor]);
const receivedCapabilities = new Map<string, { readonly value: ApplicationCapabilities; readonly expiresAt: number }>();
const replayControlIds = new Map<string, number>();
const lastSentAtByPeerId = new Map<string, number>();

export function localApplicationCapabilities(): ApplicationCapabilities {
  return {
    applicationVersions: ["branch.application-payload/0.draft"],
    kinds: ["branch.chat.text/0.draft"],
    maxInlineBytes: 3_000,
    attachmentMode: "none",
    maxRelayAttachmentBytes: 0,
    maxDirectAttachmentBytes: 0
  };
}

export function peerSupportsChatText(peerId: string, now: number = Date.now()): boolean {
  pruneCapabilityState(now);
  const cached = receivedCapabilities.get(peerId);
  return cached !== undefined && cached.expiresAt > now &&
    cached.value.applicationVersions.includes("branch.application-payload/0.draft") &&
    cached.value.kinds.includes("branch.chat.text/0.draft");
}

export async function sendApplicationCapabilities(options: {
  readonly senderPeerId: string;
  readonly recipientPeerId: string;
  readonly recipientHpkePublicKey: string;
  readonly attached: boolean;
}): Promise<"sent" | "skipped"> {
  if (!options.attached || !consumeCapabilityRate(options.recipientPeerId, Date.now())) {
    return "skipped";
  }
  const keys = getLocalIdentityKeys();
  if (keys === null) {
    return "skipped";
  }
  const now = Date.now();
  const unsigned = prepareOutboundApplicationControl({
    kind: applicationCapabilitiesControlKind,
    controlId: createDeliveryID(),
    issuedAt: now,
    expiresAt: now + applicationCapabilitiesControlTTLms,
    senderPeerId: options.senderPeerId,
    recipientPeerId: options.recipientPeerId,
    body: localApplicationCapabilities()
  }, applicationCapabilitiesControlDescriptor, {
    now,
    localPeerId: options.senderPeerId,
    isKnownContact: (peerId) => peerId === options.recipientPeerId,
    isAllowed: () => true,
    consumeRateLimit: () => true,
    maxClockSkewMs: 1_000
  });
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", keys.relayPrivateKey, toArrayBuffer(applicationControlSigningBytes(unsigned))));
  await sendApplicationControl({
    senderPeerId: options.senderPeerId,
    recipientPeerId: options.recipientPeerId,
    recipientHpkePublicKey: options.recipientHpkePublicKey,
    plaintext: encodeApplicationControl({ ...unsigned, signature })
  });
  return "sent";
}

export async function receiveApplicationCapabilities(options: {
  readonly plaintext: Uint8Array;
  readonly localPeerId: string;
  readonly senderPeerId: string;
  readonly knownContactId: string | null;
}): Promise<ReceivedApplicationCapabilities> {
  let envelope: ReturnType<typeof decodeApplicationControl>;
  try {
    envelope = decodeApplicationControl(options.plaintext);
  } catch {
    return { handled: false };
  }
  if (envelope.kind !== applicationCapabilitiesControlKind) {
    return { handled: false };
  }
  const now = Date.now();
  pruneCapabilityState(now);
  const result = await processApplicationControl(options.plaintext, capabilityRegistry, {
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
  const effect = result.effects.find((candidate) => candidate.kind === "ephemeral_projection" && candidate.projection === "application_capabilities");
  if (effect?.kind !== "ephemeral_projection") {
    return { handled: true, outcome: "effect_forbidden" };
  }
  const capabilities = decodeApplicationCapabilities(effect.value);
  rememberPeerCapabilities(options.senderPeerId, capabilities, effect.expiresAt);
  return { handled: true, outcome: "accepted", capabilities, expiresAt: effect.expiresAt };
}

function consumeCapabilityRate(peerId: string, now: number): boolean {
  pruneCapabilityState(now);
  const last = lastSentAtByPeerId.get(peerId) ?? 0;
  if (now - last < capabilityRenewIntervalMs) return false;
  trimOldest(lastSentAtByPeerId, maxCapabilityCacheEntries);
  lastSentAtByPeerId.set(peerId, now);
  return true;
}

function rememberPeerCapabilities(peerId: string, value: ApplicationCapabilities, expiresAt: number): void {
  trimOldest(receivedCapabilities, maxCapabilityCacheEntries);
  receivedCapabilities.set(peerId, { value, expiresAt });
}

function pruneCapabilityState(now: number): void {
  for (const [peerId, entry] of receivedCapabilities) if (entry.expiresAt <= now) receivedCapabilities.delete(peerId);
  for (const [controlId, expiresAt] of replayControlIds) if (expiresAt <= now) replayControlIds.delete(controlId);
  while (replayControlIds.size > maxCapabilityReplayEntries) replayControlIds.delete(replayControlIds.keys().next().value as string);
  for (const [peerId, sentAt] of lastSentAtByPeerId) if (now - sentAt >= capabilityRenewIntervalMs) lastSentAtByPeerId.delete(peerId);
}

function trimOldest<T>(map: Map<string, T>, maximum: number): void {
  if (map.size >= maximum) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
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
