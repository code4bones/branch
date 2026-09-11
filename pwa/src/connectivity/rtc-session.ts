import {
  encodeBase64URL,
  maxRtcCandidatesPerDirection,
  rtcCandidateControlKind,
  rtcCancelControlKind,
  rtcDescriptionSHA256,
  rtcOfferControlKind,
  rtcAnswerControlKind,
  rtcSignalingControlTTLms,
  rtcSignalingVersion,
  validateRtcCandidate,
  validateRtcAnswer,
  validateRtcOffer,
  type RtcAnswer,
  type RtcCandidate,
  type RtcCapabilities,
  type RtcCancel,
  type RtcOffer
} from "@code4bones/branch-core";

// This controller intentionally depends on ports rather than browser globals.
// The control ingress verifies the signed application-control body before it
// reaches this boundary; the controller verifies the SDP hash and fingerprint
// again before a peer-connection port can observe it.
export interface RTCPeerConnectionPort {
  createOffer(): Promise<string>;
  createAnswer(): Promise<string>;
  setLocalDescription(description: string): Promise<void>;
  setRemoteDescription(description: string): Promise<void>;
  addIceCandidate(candidate: string): Promise<void>;
  close(): void;
  onIceCandidate(listener: (candidate: string | null) => void): void;
  createDataChannel(label: string): RTCDataChannelPort;
  onDataChannel(listener: (channel: RTCDataChannelPort) => void): void;
}

export interface RTCDataChannelPort {
  readonly label: string;
  readonly ordered: boolean;
  readonly negotiated: boolean;
  readonly maxPacketLifeTime: number | null;
  readonly maxRetransmits: number | null;
  binaryType: "arraybuffer" | "blob";
  send(bytes: Uint8Array): void;
  onMessage(listener: (data: unknown) => void): void;
  close(): void;
}

export type RTCSignal =
  | { readonly kind: typeof rtcOfferControlKind; readonly body: RtcOffer }
  | { readonly kind: typeof rtcAnswerControlKind; readonly body: RtcAnswer }
  | { readonly kind: typeof rtcCandidateControlKind; readonly body: RtcCandidate }
  | { readonly kind: typeof rtcCancelControlKind; readonly body: RtcCancel };

export type RTCSignalResult = "accepted" | "ignored" | "duplicate" | "rejected";

export interface RTCSessionControllerOptions {
  readonly localPeerId: string;
  readonly createConnection: (peerId: string) => RTCPeerConnectionPort;
  readonly sendSignal: (peerId: string, signal: RTCSignal) => Promise<void>;
  readonly now?: () => number;
  readonly newSessionId?: () => string;
  // Only fixed implementation-state labels may enter the optional diagnostic
  // front. SDP, candidates, ids and any transport material remain secret.
  readonly onTrace?: (detail: "rtc.offer" | "rtc.answer" | "rtc.candidate" | "rtc.cancel" | "rtc.glare" | "rtc.rejected") => void;
  readonly onDataChannel?: (session: { readonly peerId: string; readonly rtcSessionId: string; readonly expiresAt: number; readonly channel: RTCDataChannelPort }) => void;
}

interface RemoteCapabilities {
  readonly value: RtcCapabilities;
  readonly expiresAt: number;
}

interface Session {
  readonly peerId: string;
  readonly id: string;
  readonly generation: number;
  readonly role: "offerer" | "answerer";
  readonly connection: RTCPeerConnectionPort;
  readonly localDescriptionSHA256: string;
  remoteDescriptionSHA256: string | null;
  expiresAt: number;
  readonly receivedCandidates: Set<string>;
  sentCandidates: number;
  channel: RTCDataChannelPort | null;
}

const maxSessions = 32;
const maxCapabilityEntries = 64;
export const rtcDataChannelLabel = "branch.rtc.data/0.draft";

export class RTCSessionController {
  readonly #sessions = new Map<string, Session>();
  readonly #capabilities = new Map<string, RemoteCapabilities>();
  readonly #now: () => number;
  readonly #newSessionId: () => string;

  constructor(private readonly options: RTCSessionControllerOptions) {
    if (options.localPeerId.length === 0) throw new Error("invalid local rtc peer");
    this.#now = options.now ?? (() => Date.now());
    this.#newSessionId = options.newSessionId ?? randomSessionId;
  }

  acceptCapabilities(peerId: string, value: RtcCapabilities, expiresAt: number): boolean {
    const now = this.#now();
    this.prune(now);
    if (peerId.length === 0 || expiresAt <= now) return false;
    while (this.#capabilities.size >= maxCapabilityEntries && !this.#capabilities.has(peerId)) {
      this.#capabilities.delete(this.#capabilities.keys().next().value as string);
    }
    this.#capabilities.set(peerId, { value, expiresAt });
    return true;
  }

  async start(peerId: string): Promise<boolean> {
    const now = this.#now();
    this.prune(now);
    const capabilities = this.#capabilities.get(peerId);
    if (peerId.length === 0 || capabilities === undefined || capabilities.expiresAt <= now) return false;
    // A refreshed capability is not a restart request. Keeping an active
    // session prevents a benign re-advertisement from tearing down a direct
    // path and producing a fresh offer loop.
    if (this.#sessions.has(peerId)) return false;
    if (!this.makeRoom()) return false;
    const connection = this.options.createConnection(peerId);
    const channel = connection.createDataChannel(rtcDataChannelLabel);
    if (!prepareDataChannel(channel)) {
      connection.close();
      return false;
    }
    const description = await connection.createOffer();
    const localDescriptionSHA256 = await rtcDescriptionSHA256(description);
    const fingerprint = extractDTLSFingerprintSHA256(description);
    await connection.setLocalDescription(description);
    const session: Session = {
      peerId,
      id: this.#newSessionId(),
      generation: 0,
      role: "offerer",
      connection,
      localDescriptionSHA256,
      remoteDescriptionSHA256: null,
      expiresAt: now + rtcSignalingControlTTLms,
      receivedCandidates: new Set(),
      sentCandidates: 0,
      channel
    };
    this.#sessions.set(peerId, session);
    this.bindLocalCandidates(session);
    try {
      await this.emit(peerId, {
        kind: rtcOfferControlKind,
        body: { version: rtcSignalingVersion, rtcSessionId: session.id, generation: session.generation, description, descriptionSHA256: localDescriptionSHA256, dtlsFingerprintSHA256: fingerprint }
      });
    } catch (cause) {
      this.drop(peerId);
      throw cause;
    }
    this.publishDataChannel(session);
    this.options.onTrace?.("rtc.offer");
    return true;
  }

  async receive(peerId: string, signal: RTCSignal): Promise<RTCSignalResult> {
    const now = this.#now();
    this.prune(now);
    try {
      switch (signal.kind) {
        case rtcOfferControlKind: return await this.receiveOffer(peerId, signal.body, now);
        case rtcAnswerControlKind: return await this.receiveAnswer(peerId, signal.body, now);
        case rtcCandidateControlKind: return await this.receiveCandidate(peerId, signal.body, now);
        case rtcCancelControlKind: return this.receiveCancel(peerId, signal.body);
      }
    } catch {
      this.options.onTrace?.("rtc.rejected");
      return "rejected";
    }
  }

  reset(): void {
    for (const session of this.#sessions.values()) session.connection.close();
    this.#sessions.clear();
    this.#capabilities.clear();
  }

  private async receiveOffer(peerId: string, offer: RtcOffer, now: number): Promise<RTCSignalResult> {
    await validateRtcOffer(offer);
    if (extractDTLSFingerprintSHA256(offer.description) !== offer.dtlsFingerprintSHA256) throw new Error("rtc fingerprint mismatch");
    const existing = this.#sessions.get(peerId);
    if (existing?.role === "offerer") {
      if (this.options.localPeerId < peerId) {
        this.options.onTrace?.("rtc.glare");
        return "ignored";
      }
      this.drop(peerId);
    } else if (existing !== undefined) {
      if (existing.id === offer.rtcSessionId && existing.remoteDescriptionSHA256 === offer.descriptionSHA256) return "duplicate";
      return "rejected";
    }
    if (!this.makeRoom()) return "rejected";
    const connection = this.options.createConnection(peerId);
    const pendingChannels: RTCDataChannelPort[] = [];
    connection.onDataChannel((channel) => {
      if (pendingChannels.length > 0) {
        channel.close();
        return;
      }
      pendingChannels.push(channel);
    });
    await connection.setRemoteDescription(offer.description);
    const description = await connection.createAnswer();
    const localDescriptionSHA256 = await rtcDescriptionSHA256(description);
    const fingerprint = extractDTLSFingerprintSHA256(description);
    await connection.setLocalDescription(description);
    const session: Session = {
      peerId,
      id: offer.rtcSessionId,
      generation: offer.generation,
      role: "answerer",
      connection,
      localDescriptionSHA256,
      remoteDescriptionSHA256: offer.descriptionSHA256,
      expiresAt: now + rtcSignalingControlTTLms,
      receivedCandidates: new Set(),
      sentCandidates: 0,
      channel: null
    };
    this.#sessions.set(peerId, session);
    this.bindLocalCandidates(session);
    connection.onDataChannel((channel) => { this.acceptDataChannel(session, channel); });
    const pendingChannel = pendingChannels.shift();
    if (pendingChannel !== undefined) this.acceptDataChannel(session, pendingChannel);
    try {
      await this.emit(peerId, {
        kind: rtcAnswerControlKind,
        body: {
          version: rtcSignalingVersion,
          rtcSessionId: session.id,
          generation: session.generation,
          description,
          descriptionSHA256: localDescriptionSHA256,
          dtlsFingerprintSHA256: fingerprint,
          offerDescriptionSHA256: offer.descriptionSHA256
        }
      });
    } catch (cause) {
      this.drop(peerId);
      throw cause;
    }
    this.publishDataChannel(session);
    this.options.onTrace?.("rtc.answer");
    return "accepted";
  }

  private async receiveAnswer(peerId: string, answer: RtcAnswer, now: number): Promise<RTCSignalResult> {
    await validateRtcAnswer(answer);
    if (extractDTLSFingerprintSHA256(answer.description) !== answer.dtlsFingerprintSHA256) throw new Error("rtc fingerprint mismatch");
    const session = this.#sessions.get(peerId);
    if (session === undefined || session.role !== "offerer" || session.id !== answer.rtcSessionId || session.generation !== answer.generation || session.localDescriptionSHA256 !== answer.offerDescriptionSHA256) return "rejected";
    if (session.remoteDescriptionSHA256 === answer.descriptionSHA256) return "duplicate";
    if (session.remoteDescriptionSHA256 !== null) return "rejected";
    await session.connection.setRemoteDescription(answer.description);
    session.remoteDescriptionSHA256 = answer.descriptionSHA256;
    // A refreshed answer lifetime is bounded by the received signed control,
    // never a browser connection-state event.
    session.expiresAt = now + rtcSignalingControlTTLms;
    return "accepted";
  }

  private async receiveCandidate(peerId: string, candidate: RtcCandidate, now: number): Promise<RTCSignalResult> {
    validateRtcCandidate(candidate);
    const session = this.#sessions.get(peerId);
    if (session === undefined || session.id !== candidate.rtcSessionId || session.generation !== candidate.generation) return "rejected";
    const remoteDirection = session.role === "offerer" ? "answerer" : "offerer";
    if (candidate.direction !== remoteDirection || session.remoteDescriptionSHA256 !== candidate.descriptionSHA256) return "rejected";
    const key = `${candidate.descriptionSHA256}\u0000${candidate.candidate}`;
    if (session.receivedCandidates.has(key)) return "duplicate";
    if (session.receivedCandidates.size >= maxRtcCandidatesPerDirection) return "rejected";
    await session.connection.addIceCandidate(candidate.candidate);
    session.receivedCandidates.add(key);
    session.expiresAt = now + rtcSignalingControlTTLms;
    return "accepted";
  }

  private receiveCancel(peerId: string, cancel: RtcCancel): RTCSignalResult {
    const session = this.#sessions.get(peerId);
    if (session === undefined || session.id !== cancel.rtcSessionId || session.generation !== cancel.generation || session.remoteDescriptionSHA256 !== cancel.descriptionSHA256) return "rejected";
    this.drop(peerId);
    this.options.onTrace?.("rtc.cancel");
    return "accepted";
  }

  private bindLocalCandidates(session: Session): void {
    session.connection.onIceCandidate((candidate) => {
      if (candidate === null || this.#sessions.get(session.peerId) !== session || session.sentCandidates >= maxRtcCandidatesPerDirection) return;
      session.sentCandidates += 1;
      const signal: RTCSignal = {
        kind: rtcCandidateControlKind,
        body: {
          version: rtcSignalingVersion,
          rtcSessionId: session.id,
          generation: session.generation,
          direction: session.role,
          descriptionSHA256: session.localDescriptionSHA256,
          candidate
        }
      };
      void this.emit(session.peerId, signal).then(() => { this.options.onTrace?.("rtc.candidate"); }).catch(() => { this.options.onTrace?.("rtc.rejected"); });
    });
  }

  private acceptDataChannel(session: Session, channel: RTCDataChannelPort): void {
    if (this.#sessions.get(session.peerId) !== session || session.channel !== null || !prepareDataChannel(channel)) {
      channel.close();
      return;
    }
    session.channel = channel;
  }

  private publishDataChannel(session: Session): void {
    if (session.channel === null) return;
    try {
      this.options.onDataChannel?.({ peerId: session.peerId, rtcSessionId: session.id, expiresAt: session.expiresAt, channel: session.channel });
    } catch {
      // A local data-plane adapter must never destabilize authenticated
      // signaling state. The channel stays inert unless its adapter attached.
    }
  }

  private async emit(peerId: string, signal: RTCSignal): Promise<void> {
    await this.options.sendSignal(peerId, signal);
  }

  private drop(peerId: string): void {
    const existing = this.#sessions.get(peerId);
    existing?.channel?.close();
    if (existing !== undefined) existing.connection.close();
    this.#sessions.delete(peerId);
  }

  private makeRoom(): boolean {
    if (this.#sessions.size < maxSessions) return true;
    const oldest = this.#sessions.keys().next().value;
    if (oldest === undefined) return false;
    this.drop(oldest);
    return true;
  }

  private prune(now: number): void {
    for (const [peerId, entry] of this.#capabilities) if (entry.expiresAt <= now) this.#capabilities.delete(peerId);
    for (const [peerId, session] of this.#sessions) if (session.expiresAt <= now) this.drop(peerId);
  }
}

// SDP has no generic fingerprint parsing surface: one sha-256 line is the
// only accepted form. An absent, duplicate, non-sha-256 or malformed line is
// rejected before the description is handed to the browser port.
export function extractDTLSFingerprintSHA256(description: string): string {
  const fingerprintLines = description.split("\n").filter((line) => line.replace(/\r$/u, "").startsWith("a=fingerprint:"));
  const line = fingerprintLines[0];
  if (fingerprintLines.length !== 1 || line === undefined) throw new Error("invalid rtc fingerprint line");
  const match = /^a=fingerprint:sha-256 ((?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2})\r?$/u.exec(line);
  const hexadecimal = match?.[1];
  if (hexadecimal === undefined) throw new Error("invalid rtc fingerprint line");
  const bytes = new Uint8Array(hexadecimal.split(":").map((part) => Number.parseInt(part, 16)));
  return encodeBase64URL(bytes);
}

function prepareDataChannel(channel: RTCDataChannelPort): boolean {
  if (channel.label !== rtcDataChannelLabel || !channel.ordered || channel.negotiated || channel.maxPacketLifeTime !== null || channel.maxRetransmits !== null) return false;
  channel.binaryType = "arraybuffer";
  return true;
}

function randomSessionId(): string {
  return encodeBase64URL(crypto.getRandomValues(new Uint8Array(16)));
}
