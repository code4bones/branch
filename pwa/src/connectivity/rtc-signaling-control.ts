import {
  applicationControlSigningBytes,
  decodeApplicationControl,
  encodeApplicationControl,
  rtcAnswerControlKind,
  rtcCapabilitiesControlKind,
  rtcCandidateControlKind,
  rtcCancelControlKind,
  rtcOfferControlKind,
  rtcRestartControlKind,
  rtcSignalingControlTTLms,
  rtcCapabilitiesControlTTLms,
  decodeBase64URL,
  decodeRtcAnswer,
  decodeRtcCapabilities,
  decodeRtcCandidate,
  decodeRtcCancel,
  decodeRtcOffer,
  decodeRtcRestart,
  encodeRtcAnswer,
  encodeRtcCapabilities,
  encodeRtcCandidate,
  encodeRtcCancel,
  encodeRtcOffer,
  encodeRtcRestart,
  type RtcSignalingBody
} from "@code4bones/branch-core";

import { getLocalIdentityKeys } from "../identity/identity-keys.js";
import { createDeliveryID, sendApplicationControl } from "./seal-and-send.js";

export type RTCSignalingControlOutcome =
  | "accepted"
  | "malformed"
  | "recipient_mismatch"
  | "unknown_contact"
  | "expired"
  | "future_issued"
  | "ttl_exceeded"
  | "replay"
  | "signature_invalid"
  | "body_invalid";

export interface ReceivedRTCSignalingControl {
  readonly handled: boolean;
  readonly outcome?: RTCSignalingControlOutcome;
  readonly kind?: RTCSignalingKind;
  readonly body?: RtcSignalingBody;
  readonly expiresAt?: number;
}

export type RTCSignalingKind =
  | typeof rtcCapabilitiesControlKind
  | typeof rtcOfferControlKind
  | typeof rtcAnswerControlKind
  | typeof rtcCandidateControlKind
  | typeof rtcRestartControlKind
  | typeof rtcCancelControlKind;

const maxReplayEntries = 128;
const maxOutboundEntries = 64;
const maxOutboundSignalsPerPeer = 40;

// This is a deliberately separate application-control adapter rather than a
// shortcut through browser APIs. Its callback receives only a canonical,
// signature-verified typed body for a known peer. Unknown controls remain
// inert so adding this extension cannot turn arbitrary application plaintext
// into a signaling oracle.
export class RTCSignalingControlRuntime {
  readonly #seen = new Map<string, number>();
  readonly #outbound = new Map<string, { readonly expiresAt: number; count: number }>();

  async receive(options: {
    readonly plaintext: Uint8Array;
    readonly localPeerId: string;
    readonly senderPeerId: string;
    readonly knownContactId: string | null;
    readonly now?: number;
  }): Promise<ReceivedRTCSignalingControl> {
    let envelope: ReturnType<typeof decodeApplicationControl>;
    try {
      envelope = decodeApplicationControl(options.plaintext);
    } catch {
      return { handled: false };
    }
    if (!isRTCSignalingKind(envelope.kind)) return { handled: false };
    const now = options.now ?? Date.now();
    this.prune(now);
    if (envelope.recipientPeerId !== options.localPeerId) return rejected("recipient_mismatch");
    if (envelope.senderPeerId !== options.senderPeerId || options.knownContactId === null) return rejected("unknown_contact");
    if (envelope.expiresAt <= now) return rejected("expired");
    if (envelope.issuedAt > now + 1_000) return rejected("future_issued");
    if (envelope.expiresAt - envelope.issuedAt > maximumTTL(envelope.kind)) return rejected("ttl_exceeded");
    if (this.#seen.has(envelope.controlId)) return rejected("replay");
    if (!await verifyControlSignature(envelope.senderPeerId, applicationControlSigningBytes(envelope), envelope.signature)) return rejected("signature_invalid");
    let body: RtcSignalingBody;
    try {
      body = await decodeBody(envelope.kind, envelope.body);
    } catch {
      return rejected("body_invalid");
    }
    this.remember(this.#seen, envelope.controlId, envelope.expiresAt, maxReplayEntries);
    return { handled: true, outcome: "accepted", kind: envelope.kind, body, expiresAt: envelope.expiresAt };
  }

  async send(options: {
    readonly senderPeerId: string;
    readonly recipientPeerId: string;
    readonly recipientHpkePublicKey: string;
    readonly kind: RTCSignalingKind;
    readonly body: RtcSignalingBody;
    readonly now?: number;
  }): Promise<void> {
    const keys = getLocalIdentityKeys();
    if (keys === null) throw new Error("local identity is unavailable");
    const now = options.now ?? Date.now();
    this.prune(now);
    const body = await encodeBody(options.kind, options.body);
    const expiresAt = now + maximumTTL(options.kind);
    this.consumeOutbound(options.recipientPeerId, expiresAt, now);
    const unsigned = {
      version: "branch.application-control/0.draft" as const,
      kind: options.kind,
      controlId: createDeliveryID(),
      issuedAt: now,
      expiresAt,
      senderPeerId: options.senderPeerId,
      recipientPeerId: options.recipientPeerId,
      body
    };
    const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", keys.relayPrivateKey, toArrayBuffer(applicationControlSigningBytes(unsigned))));
    await sendApplicationControl({
      senderPeerId: options.senderPeerId,
      recipientPeerId: options.recipientPeerId,
      recipientHpkePublicKey: options.recipientHpkePublicKey,
      plaintext: encodeApplicationControl({ ...unsigned, signature })
    });
  }

  reset(): void {
    this.#seen.clear();
    this.#outbound.clear();
  }

  private consumeOutbound(peerId: string, expiresAt: number, now: number): void {
    const current = this.#outbound.get(peerId);
    if (current !== undefined && current.expiresAt > now && current.count >= maxOutboundSignalsPerPeer) {
      throw new Error("rtc signaling outbound limit reached");
    }
    if (current === undefined || current.expiresAt <= now) {
      this.remember(this.#outbound, peerId, { expiresAt, count: 1 }, maxOutboundEntries);
      return;
    }
    current.count += 1;
  }

  private prune(now: number): void {
    for (const [controlId, expiresAt] of this.#seen) if (expiresAt <= now) this.#seen.delete(controlId);
    for (const [peerId, entry] of this.#outbound) if (entry.expiresAt <= now) this.#outbound.delete(peerId);
  }

  private remember<T>(map: Map<string, T>, key: string, value: T, maximum: number): void {
    while (map.size >= maximum && !map.has(key)) map.delete(map.keys().next().value as string);
    map.set(key, value);
  }
}

function rejected(outcome: Exclude<RTCSignalingControlOutcome, "accepted">): ReceivedRTCSignalingControl {
  return { handled: true, outcome };
}

function isRTCSignalingKind(value: string): value is RTCSignalingKind {
  return value === rtcCapabilitiesControlKind || value === rtcOfferControlKind || value === rtcAnswerControlKind || value === rtcCandidateControlKind || value === rtcRestartControlKind || value === rtcCancelControlKind;
}

function maximumTTL(kind: RTCSignalingKind): number {
  return kind === rtcCapabilitiesControlKind ? rtcCapabilitiesControlTTLms : rtcSignalingControlTTLms;
}

async function decodeBody(kind: RTCSignalingKind, bytes: Uint8Array): Promise<RtcSignalingBody> {
  switch (kind) {
    case rtcCapabilitiesControlKind: return decodeRtcCapabilities(bytes);
    case rtcOfferControlKind: return decodeRtcOffer(bytes);
    case rtcAnswerControlKind: return decodeRtcAnswer(bytes);
    case rtcCandidateControlKind: return decodeRtcCandidate(bytes);
    case rtcRestartControlKind: return decodeRtcRestart(bytes);
    case rtcCancelControlKind: return decodeRtcCancel(bytes);
  }
}

async function encodeBody(kind: RTCSignalingKind, body: RtcSignalingBody): Promise<Uint8Array> {
  switch (kind) {
    case rtcCapabilitiesControlKind: return encodeRtcCapabilities(body as Extract<RtcSignalingBody, { readonly maxDescriptionBytes: number }>);
    case rtcOfferControlKind: return encodeRtcOffer(body as Extract<RtcSignalingBody, { readonly description: string; readonly offerDescriptionSHA256?: never }>);
    case rtcAnswerControlKind: return encodeRtcAnswer(body as Extract<RtcSignalingBody, { readonly offerDescriptionSHA256: string }>);
    case rtcCandidateControlKind: return encodeRtcCandidate(body as Extract<RtcSignalingBody, { readonly candidate: string }>);
    case rtcRestartControlKind: return encodeRtcRestart(body as Extract<RtcSignalingBody, { readonly priorDescriptionSHA256: string }>);
    case rtcCancelControlKind: return encodeRtcCancel(body as Extract<RtcSignalingBody, { readonly reason: string }>);
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
