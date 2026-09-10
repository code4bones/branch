import {
  applicationControlSigningBytes,
  cborMap,
  createApplicationControlRegistry,
  decodeApplicationControl,
  decodeBase64URL,
  decodeDeterministicCbor,
  encodeApplicationControl,
  encodeBase64URL,
  encodeDeterministicCbor,
  getRequiredEntry,
  prepareOutboundApplicationControl,
  processApplicationControl,
  readBytes,
  readCborMap,
  readText,
  rejectUnknownEntries,
  type ApplicationControlDescriptor,
  type ApplicationControlRejection
} from "@code4bones/branch-core";

import { getLocalIdentityKeys } from "../identity/identity-keys.js";
import { createDeliveryID, sendApplicationControl } from "./seal-and-send.js";

export const deliveryReceiptControlKind = "branch.pwa.receipt/0.draft";
export const deliveryReceiptControlTTLms = 5 * 60_000;
const maxReplayEntries = 128;
const maxBodyBytes = 64;

export type DeliveryReceiptKind = "delivered" | "read";
export interface DeliveryReceiptBody {
  readonly kind: DeliveryReceiptKind;
  readonly targetDeliveryId: string;
}

export type DeliveryReceiptOutcome = "accepted" | "source_mismatch" | ApplicationControlRejection | "effect_missing";
export interface ReceivedDeliveryReceipt {
  readonly handled: boolean;
  readonly outcome?: DeliveryReceiptOutcome;
  readonly receipt?: DeliveryReceiptBody;
}

export type DeliveryReceiptSendResult = "sent" | "skipped";

const replayControlIds = new Map<string, number>();
const emittedReceiptTargets = new Map<string, number>();

export const deliveryReceiptControlDescriptor: ApplicationControlDescriptor<DeliveryReceiptBody> = {
  kind: deliveryReceiptControlKind,
  authentication: "ed25519",
  maximumTTLms: deliveryReceiptControlTTLms,
  projection: "message_metadata",
  allowedEffects: ["message_metadata"],
  decodeBody: decodeReceiptBody,
  encodeBody: encodeReceiptBody,
  reduce: ({ body }) => [{ kind: "message_metadata", deliveryId: body.targetDeliveryId, state: body.kind }]
};

const receiptRegistry = createApplicationControlRegistry([deliveryReceiptControlDescriptor]);

/** Sends one best-effort signed receipt and deliberately never queues a retry. */
export async function sendDeliveryReceipt(options: {
  readonly kind: DeliveryReceiptKind;
  readonly targetDeliveryId: string;
  readonly senderPeerId: string;
  readonly recipientPeerId: string;
  readonly recipientHpkePublicKey: string;
  readonly attached: boolean;
}): Promise<DeliveryReceiptSendResult> {
  if (!options.attached || !validDeliveryId(options.targetDeliveryId)) return "skipped";
  const keys = getLocalIdentityKeys();
  if (keys === null) return "skipped";
  const now = Date.now();
  prune(now);
  const emittedKey = `${options.kind}\n${options.recipientPeerId}\n${options.targetDeliveryId}`;
  if (emittedReceiptTargets.has(emittedKey)) return "skipped";
  let unsigned: ReturnType<typeof prepareOutboundApplicationControl<DeliveryReceiptBody>>;
  try {
    unsigned = prepareOutboundApplicationControl({
      kind: deliveryReceiptControlKind,
      controlId: createDeliveryID(),
      issuedAt: now,
      expiresAt: now + deliveryReceiptControlTTLms,
      senderPeerId: options.senderPeerId,
      recipientPeerId: options.recipientPeerId,
      body: { kind: options.kind, targetDeliveryId: options.targetDeliveryId }
    }, deliveryReceiptControlDescriptor, {
      now,
      localPeerId: options.senderPeerId,
      isKnownContact: (peerId) => peerId === options.recipientPeerId,
      isAllowed: () => true,
      consumeRateLimit: () => {
        if (emittedReceiptTargets.size >= maxReplayEntries) {
          const oldest = emittedReceiptTargets.keys().next().value;
          if (oldest !== undefined) emittedReceiptTargets.delete(oldest);
        }
        emittedReceiptTargets.set(emittedKey, now + deliveryReceiptControlTTLms);
        return true;
      },
      maxClockSkewMs: 1_000
    });
  } catch {
    return "skipped";
  }
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", keys.relayPrivateKey, toArrayBuffer(applicationControlSigningBytes(unsigned))));
  try {
    await sendApplicationControl({
      senderPeerId: options.senderPeerId,
      recipientPeerId: options.recipientPeerId,
      recipientHpkePublicKey: options.recipientHpkePublicKey,
      plaintext: encodeApplicationControl({ ...unsigned, signature })
    });
  } catch (cause) {
    // Sending failed before this endpoint had accepted the control. Release
    // the tab-local dedup key so a durable local read record can try again on
    // the next attached foreground attempt.
    emittedReceiptTargets.delete(emittedKey);
    throw cause;
  }
  return "sent";
}

/** Decodes and verifies one receipt before it can affect outgoing UI state. */
export async function receiveDeliveryReceipt(options: {
  readonly plaintext: Uint8Array;
  readonly localPeerId: string;
  readonly senderPeerId: string;
  readonly knownContactId: string | null;
}): Promise<ReceivedDeliveryReceipt> {
  let envelope: ReturnType<typeof decodeApplicationControl>;
  try {
    envelope = decodeApplicationControl(options.plaintext);
  } catch {
    return { handled: false };
  }
  if (envelope.kind !== deliveryReceiptControlKind) return { handled: false };
  if (envelope.senderPeerId !== options.senderPeerId) return { handled: true, outcome: "source_mismatch" };
  const now = Date.now();
  prune(now);
  const result = await processApplicationControl(options.plaintext, receiptRegistry, {
    now,
    localPeerId: options.localPeerId,
    isKnownContact: (peerId) => options.knownContactId !== null && peerId === options.senderPeerId,
    verifyEd25519: verifyControlSignature,
    hasSeenControl: (controlId) => replayControlIds.has(controlId),
    rememberControl: (controlId, expiresAt) => { replayControlIds.set(controlId, expiresAt); },
    isAllowed: () => true,
    maxClockSkewMs: 1_000
  });
  if (result.status !== "accepted") return { handled: true, outcome: result.reason };
  const effect = result.effects.find((candidate) => candidate.kind === "message_metadata");
  if (effect?.kind !== "message_metadata") return { handled: true, outcome: "effect_missing" };
  return { handled: true, outcome: "accepted", receipt: { kind: effect.state === "read" ? "read" : "delivered", targetDeliveryId: effect.deliveryId } };
}

export function encodeReceiptBody(value: DeliveryReceiptBody): Uint8Array {
  if (!validReceiptKind(value.kind) || !validDeliveryId(value.targetDeliveryId)) throw new Error("invalid receipt body");
  return encodeDeterministicCbor(cborMap([
    { key: "receipt_kind", value: value.kind },
    { key: "target_delivery_id", value: decodeBase64URL(value.targetDeliveryId) }
  ]));
}

export function decodeReceiptBody(bytes: Uint8Array): DeliveryReceiptBody {
  if (bytes.byteLength === 0 || bytes.byteLength > maxBodyBytes) throw new Error("invalid receipt body");
  const map = readCborMap(decodeDeterministicCbor(bytes, maxBodyBytes), "receipt");
  rejectUnknownEntries(map, ["receipt_kind", "target_delivery_id"]);
  const kind = readText(getRequiredEntry(map, "receipt_kind"), "receipt kind");
  const targetDeliveryId = encodeBase64URL(readBytes(getRequiredEntry(map, "target_delivery_id"), "target delivery id", 16));
  if (!validReceiptKind(kind)) throw new Error("invalid receipt kind");
  return { kind, targetDeliveryId };
}

function validReceiptKind(value: string): value is DeliveryReceiptKind {
  return value === "delivered" || value === "read";
}

function validDeliveryId(value: string): boolean {
  try { return decodeBase64URL(value).byteLength === 16; } catch { return false; }
}

function prune(now: number): void {
  for (const [controlId, expiresAt] of replayControlIds) if (expiresAt <= now) replayControlIds.delete(controlId);
  for (const [key, expiresAt] of emittedReceiptTargets) if (expiresAt <= now) emittedReceiptTargets.delete(key);
  while (replayControlIds.size > maxReplayEntries) replayControlIds.delete(replayControlIds.keys().next().value as string);
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
