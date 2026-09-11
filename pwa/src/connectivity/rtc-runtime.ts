import {
  maxRtcCandidateBytes,
  maxRtcCandidatesPerDirection,
  maxRtcDescriptionBytes,
  rtcCapabilitiesControlKind,
  rtcSignalingVersion,
  type RtcCapabilities
} from "@code4bones/branch-core";

import { RTCSessionController, type RTCDataChannelPort, type RTCPeerConnectionPort, type RTCSignal, type RTCSignalResult } from "./rtc-session.js";
import { RTCSignalingControlRuntime, type RTCSignalingControlOutcome } from "./rtc-signaling-control.js";

export interface RTCSessionRuntimeOptions {
  readonly localPeerId: string;
  readonly recipientHpkePublicKey: (peerId: string) => string | null;
  readonly createConnection?: (peerId: string) => RTCPeerConnectionPort;
  readonly signaling?: RTCSignalingPort;
  readonly now?: () => number;
  readonly onTrace?: (detail: "rtc.offer" | "rtc.answer" | "rtc.candidate" | "rtc.cancel" | "rtc.glare" | "rtc.rejected") => void;
  readonly onDataChannel?: (session: { readonly peerId: string; readonly rtcSessionId: string; readonly expiresAt: number; readonly channel: RTCDataChannelPort }) => void;
}

export interface RTCSignalingPort {
  receive: RTCSignalingControlRuntime["receive"];
  send: RTCSignalingControlRuntime["send"];
  reset: RTCSignalingControlRuntime["reset"];
}

export interface RTCSessionRuntimeReceive {
  readonly handled: boolean;
  readonly outcome?: RTCSignalingControlOutcome | RTCSignalResult;
}

// Endpoint-only composition root. It explicitly creates browser connections
// with an empty ICE-server list; adding STUN/TURN requires the later relay
// capability/configuration decision rather than a browser default or hidden
// project service.
export class RTCSessionRuntime {
  readonly #signals: RTCSignalingPort;
  readonly #sessions: RTCSessionController;
  readonly #capabilitySentAt = new Map<string, number>();
  #onDataChannel: RTCSessionRuntimeOptions["onDataChannel"];

  constructor(private readonly options: RTCSessionRuntimeOptions) {
    this.#signals = options.signaling ?? new RTCSignalingControlRuntime();
    this.#onDataChannel = options.onDataChannel;
    this.#sessions = new RTCSessionController({
      localPeerId: options.localPeerId,
      createConnection: options.createConnection ?? (() => new BrowserPeerConnectionPort()),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.onTrace === undefined ? {} : { onTrace: options.onTrace }),
      onDataChannel: (session) => { this.#onDataChannel?.(session); },
      sendSignal: async (peerId, signal) => {
        const recipientHpkePublicKey = options.recipientHpkePublicKey(peerId);
        if (recipientHpkePublicKey === null) throw new Error("rtc peer has no hpke key");
        await this.#signals.send({
          senderPeerId: options.localPeerId,
          recipientPeerId: peerId,
          recipientHpkePublicKey,
          kind: signal.kind,
          body: signal.body
        });
      }
    });
  }

  async receive(input: {
    readonly plaintext: Uint8Array;
    readonly senderPeerId: string;
    readonly knownContactId: string | null;
    readonly now?: number;
  }): Promise<RTCSessionRuntimeReceive> {
    const control = await this.#signals.receive({
      plaintext: input.plaintext,
      localPeerId: this.options.localPeerId,
      senderPeerId: input.senderPeerId,
      knownContactId: input.knownContactId,
      ...(input.now === undefined ? {} : { now: input.now })
    });
    if (!control.handled || control.outcome !== "accepted" || control.kind === undefined || control.body === undefined) {
      return control.outcome === undefined ? { handled: control.handled } : { handled: control.handled, outcome: control.outcome };
    }
    if (control.kind === rtcCapabilitiesControlKind) {
      if (!this.#sessions.acceptCapabilities(input.senderPeerId, control.body as RtcCapabilities, control.expiresAt ?? 0)) {
        return { handled: true, outcome: "rejected" };
      }
      // Acceptance is determined by the verified remote control. A local
      // scheduling failure must not reinterpret it as an invalid control or
      // cause a retry storm through the relay attachment.
      try {
        await this.advertiseCapabilities(input.senderPeerId);
        if (this.options.localPeerId < input.senderPeerId) await this.#sessions.start(input.senderPeerId);
      } catch {
        // The next bounded capability advertisement can establish a fresh
        // session attempt; no browser state is made durable here.
      }
      return { handled: true, outcome: "accepted" };
    }
    // Restart remains a signed, bounded and replay-protected wire body but is
    // intentionally not mapped to Browser API effects until its generation
    // transition is implemented and tested. A valid but unsupported endpoint
    // extension is rejected locally, never forwarded or retried.
    if (control.kind === "branch.rtc.restart/0.draft") return { handled: true, outcome: "rejected" };
    return { handled: true, outcome: await this.#sessions.receive(input.senderPeerId, { kind: control.kind, body: control.body } as RTCSignal) };
  }

  async advertiseCapabilities(peerId: string): Promise<"sent" | "skipped"> {
    const now = this.options.now?.() ?? Date.now();
    const lastSentAt = this.#capabilitySentAt.get(peerId);
    if (lastSentAt !== undefined && now - lastSentAt < 30_000) return "skipped";
    const recipientHpkePublicKey = this.options.recipientHpkePublicKey(peerId);
    if (recipientHpkePublicKey === null) return "skipped";
    await this.#signals.send({
      senderPeerId: this.options.localPeerId,
      recipientPeerId: peerId,
      recipientHpkePublicKey,
      kind: rtcCapabilitiesControlKind,
      body: { version: rtcSignalingVersion, maxDescriptionBytes: maxRtcDescriptionBytes, maxCandidateBytes: maxRtcCandidateBytes, maxCandidatesPerDirection: maxRtcCandidatesPerDirection }
    });
    while (this.#capabilitySentAt.size >= 64 && !this.#capabilitySentAt.has(peerId)) this.#capabilitySentAt.delete(this.#capabilitySentAt.keys().next().value as string);
    this.#capabilitySentAt.set(peerId, now);
    return "sent";
  }

  start(peerId: string): Promise<boolean> {
    return this.#sessions.start(peerId);
  }

  reset(): void {
    this.#sessions.reset();
    this.#signals.reset();
    this.#capabilitySentAt.clear();
  }

  setDataChannelHandler(handler: RTCSessionRuntimeOptions["onDataChannel"]): void {
    this.#onDataChannel = handler;
  }
}

let liveRuntime: { readonly localPeerId: string; readonly runtime: RTCSessionRuntime } | null = null;

// The tab keeps one volatile runtime alongside its one relay attachment. It
// has no durable session recovery: a relay disconnect or identity change
// closes browser connections and discards replay/capability state.
export async function receiveLiveRTCSignaling(input: {
  readonly plaintext: Uint8Array;
  readonly localPeerId: string;
  readonly senderPeerId: string;
  readonly knownContactId: string | null;
  readonly recipientHpkePublicKey: (peerId: string) => string | null;
  readonly onDataChannel?: RTCSessionRuntimeOptions["onDataChannel"];
}): Promise<RTCSessionRuntimeReceive> {
  const runtime = liveRuntimeFor(input.localPeerId, input.recipientHpkePublicKey);
  runtime.setDataChannelHandler(input.onDataChannel);
  return runtime.receive(input);
}

export async function advertiseLiveRTCCapabilities(input: {
  readonly localPeerId: string;
  readonly peerId: string;
  readonly recipientHpkePublicKey: (peerId: string) => string | null;
}): Promise<"sent" | "skipped"> {
  return await liveRuntimeFor(input.localPeerId, input.recipientHpkePublicKey).advertiseCapabilities(input.peerId);
}

export function clearLiveRTCSignaling(): void {
  liveRuntime?.runtime.reset();
  liveRuntime = null;
}

function liveRuntimeFor(localPeerId: string, recipientHpkePublicKey: (peerId: string) => string | null): RTCSessionRuntime {
  if (liveRuntime === null || liveRuntime.localPeerId !== localPeerId) {
    liveRuntime?.runtime.reset();
    liveRuntime = { localPeerId, runtime: new RTCSessionRuntime({ localPeerId, recipientHpkePublicKey }) };
  }
  return liveRuntime.runtime;
}

class BrowserPeerConnectionPort implements RTCPeerConnectionPort {
  readonly #connection = new RTCPeerConnection({ iceServers: [] });

  async createOffer(): Promise<string> {
    return descriptionSDP(await this.#connection.createOffer());
  }

  async createAnswer(): Promise<string> {
    return descriptionSDP(await this.#connection.createAnswer());
  }

  async setLocalDescription(description: string): Promise<void> {
    await this.#connection.setLocalDescription({ type: this.#connection.remoteDescription === null ? "offer" : "answer", sdp: description });
  }

  async setRemoteDescription(description: string): Promise<void> {
    await this.#connection.setRemoteDescription({ type: this.#connection.localDescription === null ? "offer" : "answer", sdp: description });
  }

  async addIceCandidate(candidate: string): Promise<void> {
    await this.#connection.addIceCandidate({ candidate });
  }

  close(): void {
    this.#connection.close();
  }

  onIceCandidate(listener: (candidate: string | null) => void): void {
    this.#connection.addEventListener("icecandidate", (event) => { listener(event.candidate?.candidate ?? null); });
  }

  createDataChannel(label: string): RTCDataChannelPort {
    return new BrowserDataChannelPort(this.#connection.createDataChannel(label, { ordered: true, negotiated: false }));
  }

  onDataChannel(listener: (channel: RTCDataChannelPort) => void): void {
    this.#connection.addEventListener("datachannel", (event) => { listener(new BrowserDataChannelPort(event.channel)); });
  }
}

class BrowserDataChannelPort implements RTCDataChannelPort {
  constructor(private readonly channel: RTCDataChannel) {}

  get label(): string { return this.channel.label; }
  get ordered(): boolean { return this.channel.ordered; }
  get negotiated(): boolean { return this.channel.negotiated; }
  get maxPacketLifeTime(): number | null { return this.channel.maxPacketLifeTime; }
  get maxRetransmits(): number | null { return this.channel.maxRetransmits; }
  get binaryType(): "arraybuffer" | "blob" { return this.channel.binaryType; }
  set binaryType(value: "arraybuffer" | "blob") { this.channel.binaryType = value; }
  send(bytes: Uint8Array): void { this.channel.send(new Uint8Array(bytes)); }
  onMessage(listener: (data: unknown) => void): void { this.channel.addEventListener("message", (event) => { listener(event.data); }); }
  close(): void { this.channel.close(); }
}

function descriptionSDP(description: RTCSessionDescriptionInit): string {
  if (typeof description.sdp !== "string" || description.sdp.length === 0) throw new Error("browser rtc description is missing SDP");
  return description.sdp;
}
