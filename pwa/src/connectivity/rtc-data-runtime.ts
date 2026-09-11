import {
  decodeBase64URL,
  decodeRtcDataFrame,
  encodeRtcAdmit,
  encodeRtcData,
  type RtcAdmit,
  type RtcData
} from "@code4bones/branch-core";

import { getLocalIdentityKeys } from "../identity/identity-keys.js";
import { openIncomingEnvelope } from "./open-envelope.js";
import { fixedAckRequested, fixedPathEpoch, fixedStreamId } from "./payload-aad-defaults.js";
import { RTCAdmissionLedger } from "./rtc-admission-ledger.js";
import type { RTCDataChannelPort } from "./rtc-session.js";

export type RTCDataIngressOutcome = "admitted" | "duplicate" | "pending" | "conflict" | "rejected" | "admit";
export const maxRTCDataInFlight = 32;
export const rtcDataAdmitTimeoutMs = 8_000;

export interface RTCDataIngressOptions {
  readonly localPeerId: string;
  readonly remotePeerId: string;
  readonly rtcSessionId: string;
  readonly expiresAt: number;
  readonly channel: RTCDataChannelPort;
  // Dispatch is deliberately post-HPKE and caller-owned. It must not assign a
  // relay forwarding or user-facing delivery claim; successful completion only
  // authorizes the narrow direct ADMIT.
  readonly dispatch: (input: { readonly plaintext: Uint8Array; readonly deliveryId: string; readonly ciphertext: string; readonly originRouteId: string }) => Promise<boolean>;
  readonly now?: () => number;
  readonly onAdmit?: (deliveryId: string) => void;
}

// This volatile ingress adapter owns only D94 admission. It neither opens a
// relay route nor touches Zustand/IndexedDB. A UI/transport composition root
// supplies plaintext dispatch after the existing HPKE AAD verification.
export class RTCDataIngressRuntime {
  readonly #ledger = new RTCAdmissionLedger();
  readonly #now: () => number;

  constructor(private readonly options: RTCDataIngressOptions) {
    this.#now = options.now ?? (() => Date.now());
    options.channel.onMessage((data) => { void this.receive(data); });
  }

  async receive(raw: unknown): Promise<RTCDataIngressOutcome> {
    const now = this.#now();
    if (now >= this.options.expiresAt) {
      this.#ledger.reset();
      return "rejected";
    }
    const bytes = binaryFrame(raw);
    if (bytes === null) return "rejected";
    let frame: RtcData | RtcAdmit;
    try {
      frame = decodeRtcDataFrame(bytes);
    } catch {
      return "rejected";
    }
    if (frame.rtcSessionId !== this.options.rtcSessionId) return "rejected";
    if (frame.kind === "admit") {
      try { this.options.onAdmit?.(frame.deliveryId); } catch { /* local observer is inert */ }
      return "admit";
    }
    return this.receiveData(frame, now);
  }

  reset(): void {
    this.#ledger.reset();
  }

  private async receiveData(frame: RtcData, now: number): Promise<RTCDataIngressOutcome> {
    if (frame.pathEpoch !== fixedPathEpoch || frame.streamId !== fixedStreamId || frame.ackRequested !== fixedAckRequested) return "rejected";
    const keys = getLocalIdentityKeys();
    if (keys === null) return "rejected";
    let plaintext: Uint8Array;
    try {
      plaintext = await openIncomingEnvelope({
        senderPeerId: this.options.remotePeerId,
        recipientPeerId: this.options.localPeerId,
        originRouteId: frame.originRouteId,
        recipientHpkePrivateKey: keys.hpkePrivateKey,
        deliveryId: frame.deliveryId,
        sealedPayload: frame.ciphertext
      });
    } catch {
      return "rejected";
    }
    const ciphertext = decodeCiphertext(frame.ciphertext);
    const reservation = await this.#ledger.reserve({
      senderPeerId: this.options.remotePeerId,
      streamId: frame.streamId,
      deliveryId: frame.deliveryId,
      ciphertext,
      expiresAt: this.options.expiresAt,
      now
    });
    if (reservation.kind === "conflict") return "conflict";
    if (reservation.kind === "duplicate_pending") return "pending";
    if (reservation.kind === "duplicate_admitted") return this.sendAdmit(frame.deliveryId) ? "duplicate" : "rejected";
    try {
      if (!await this.options.dispatch({ plaintext, deliveryId: frame.deliveryId, ciphertext: frame.ciphertext, originRouteId: frame.originRouteId })) {
        return "rejected";
      }
    } catch {
      return "rejected";
    }
    if (!this.#ledger.admit(this.options.remotePeerId, frame.streamId, frame.deliveryId, this.#now())) return "rejected";
    return this.sendAdmit(frame.deliveryId) ? "admitted" : "rejected";
  }

  private sendAdmit(deliveryId: string): boolean {
    try {
      this.options.channel.send(encodeRtcAdmit({ kind: "admit", version: "branch.rtc.data/0.draft", rtcSessionId: this.options.rtcSessionId, deliveryId }));
      return true;
    } catch {
      return false;
    }
  }
}

interface RTCDirectPending {
  readonly frame: RtcData;
  readonly timeout: ReturnType<typeof setTimeout>;
  readonly fallbackToWSS: (frame: RtcData) => Promise<void>;
}

export interface RTCDirectSenderOptions {
  readonly rtcSessionId: string;
  readonly channel: RTCDataChannelPort;
  readonly fallbackToWSS: (frame: RtcData) => Promise<void>;
  readonly schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}

// Owns one active session's local DATA attempt window. It deliberately does
// not expose browser buffering as a network fact and never projects an ADMIT
// into relay forwarding or a user delivery state.
export class RTCDirectSender {
  readonly #pending = new Map<string, RTCDirectPending>();
  readonly #schedule: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly #cancel: (timer: ReturnType<typeof setTimeout>) => void;

  constructor(private readonly options: RTCDirectSenderOptions) {
    this.#schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#cancel = options.cancel ?? ((timer) => { clearTimeout(timer); });
  }

  send(frame: RtcData, fallbackToWSS = this.options.fallbackToWSS): boolean {
    if (frame.rtcSessionId !== this.options.rtcSessionId || this.#pending.has(frame.deliveryId) || this.#pending.size >= maxRTCDataInFlight) return false;
    let bytes: Uint8Array;
    try {
      bytes = encodeRtcData(frame);
    } catch {
      return false;
    }
    const timeout = this.#schedule(() => { void this.fallback(frame.deliveryId); }, rtcDataAdmitTimeoutMs);
    this.#pending.set(frame.deliveryId, { frame, timeout, fallbackToWSS });
    try {
      this.options.channel.send(bytes);
      return true;
    } catch {
      void this.fallback(frame.deliveryId);
      // This attempt now owns its single asynchronous WSS fallback. Returning
      // true prevents the caller from issuing a second fallback itself.
      return true;
    }
  }

  admit(value: RtcAdmit): boolean {
    if (value.rtcSessionId !== this.options.rtcSessionId) return false;
    const pending = this.#pending.get(value.deliveryId);
    if (pending === undefined) return false;
    this.#cancel(pending.timeout);
    this.#pending.delete(value.deliveryId);
    return true;
  }

  async reset(): Promise<void> {
    await Promise.all(Array.from(this.#pending.keys(), async (deliveryId) => this.fallback(deliveryId)));
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  private async fallback(deliveryId: string): Promise<void> {
    const pending = this.#pending.get(deliveryId);
    if (pending === undefined) return;
    this.#cancel(pending.timeout);
    this.#pending.delete(deliveryId);
    try {
      await pending.fallbackToWSS(pending.frame);
    } catch {
      // The existing WSS sender owns its normal bounded unavailable outcome.
      // Direct transport never creates another retry queue after fallback.
    }
  }
}

const liveRTCDataSenders = new Map<string, { readonly rtcSessionId: string; readonly expiresAt: number; readonly sender: RTCDirectSender }>();

// A tab-local registry is a transport adapter, not session recovery. It holds
// one already-authenticated browser channel per peer and is cleared with the
// relay/RTC lifecycle; ciphertext, keys and conversation state never enter it.
export function installLiveRTCDataSender(input: {
  readonly peerId: string;
  readonly rtcSessionId: string;
  readonly expiresAt: number;
  readonly channel: RTCDataChannelPort;
}): RTCDirectSender {
  const previous = liveRTCDataSenders.get(input.peerId);
  if (previous !== undefined) void previous.sender.reset();
  const sender = new RTCDirectSender({
    rtcSessionId: input.rtcSessionId,
    channel: input.channel,
    fallbackToWSS: () => Promise.resolve()
  });
  liveRTCDataSenders.set(input.peerId, { rtcSessionId: input.rtcSessionId, expiresAt: input.expiresAt, sender });
  return sender;
}

export function sendLiveRTCData(input: {
  readonly peerId: string;
  readonly frame: RtcData;
  readonly fallbackToWSS: (frame: RtcData) => Promise<void>;
  readonly now?: number;
}): boolean {
  const entry = liveRTCDataSenders.get(input.peerId);
  if (entry === undefined) return false;
  if ((input.now ?? Date.now()) >= entry.expiresAt) {
    liveRTCDataSenders.delete(input.peerId);
    void entry.sender.reset();
    return false;
  }
  return entry.sender.send({ ...input.frame, rtcSessionId: entry.rtcSessionId }, input.fallbackToWSS);
}

export function clearLiveRTCDataSenders(): void {
  for (const entry of liveRTCDataSenders.values()) void entry.sender.reset();
  liveRTCDataSenders.clear();
}

function binaryFrame(raw: unknown): Uint8Array | null {
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw.slice(0));
  if (raw instanceof Uint8Array) return new Uint8Array(raw);
  return null;
}

function decodeCiphertext(value: string): Uint8Array {
  // The shared codec has already verified base64url and its 6144-byte cap;
  // re-encoding cannot become a distinct ciphertext fingerprint.
  return decodeBase64URL(value);
}
