import {
  AttachmentTransferRegistry,
  attachmentDecisionSigningBytes,
  attachmentManifestSigningBytes,
  attachmentVersion,
  decodeApplicationPayload,
  decodeAttachmentChunk,
  decodeAttachmentDecision,
  decodeAttachmentManifest,
  encodeApplicationPayload,
  encodeAttachmentChunk,
  encodeAttachmentDecision,
  encodeAttachmentManifest,
  encodeBase64URL,
  maxAttachmentChunkBytes,
  maxAttachmentTTLms,
  maxRelayAttachmentBytes,
  sha256Base64URL,
  type ApplicationCapabilities,
  type AttachmentChunk,
  type AttachmentDecision,
  type AttachmentManifest,
  type AttachmentTransferState
} from "@code4bones/branch-core";

/** Exact application-payload kinds for the endpoint-only attachment draft. */
export const attachmentManifestKind = "branch.attachment.manifest/0.draft" as const;
export const attachmentDecisionKind = "branch.attachment.decision/0.draft" as const;
export const attachmentChunkKind = "branch.attachment.chunk/0.draft" as const;

const attachmentApplicationVersion = "branch.application-payload/0.draft";
const attachmentKinds = [attachmentManifestKind, attachmentDecisionKind, attachmentChunkKind] as const;
const maximumActiveDirections = 4;
const maximumRememberedPeers = 16;
const outboundWindowSize = 4;
const relayForwardTimeoutMs = 12_000;

export type AttachmentDirection = "inbound" | "outbound";
export type AttachmentControllerReason =
  | "accepted"
  | "rejected"
  | "cancelled"
  | "expired"
  | "integrity_failed"
  | "invalid_signature"
  | "invalid_payload"
  | "unknown_peer"
  | "unsupported"
  | "busy"
  | "unavailable"
  | "disconnected"
  | "ack_timeout"
  | "send_failed";

export interface AttachmentControllerEvent {
  readonly event: "attachment.offer.sent" | "attachment.offer.received" | "attachment.transfer.accepted" | "attachment.transfer.ended";
  readonly peerId: string;
  readonly direction: AttachmentDirection;
  readonly reason: AttachmentControllerReason;
  // Presentation metadata is exposed only with a terminal live transfer
  // event. It is never logged by the controller runtime or persisted here.
  readonly fileName?: string;
  readonly byteCount?: number;
}

/**
 * A verified inbound offer. Its manifest is a detached core copy and contains
 * no received file bytes. It is safe to hand to the volatile UI boundary.
 */
export interface InboundAttachmentOffer {
  readonly peerId: string;
  readonly manifest: AttachmentManifest;
}

/**
 * Browser-bound dependencies. The controller deliberately receives all
 * identity, transport and timer authority instead of importing React, relay
 * singletons, local storage, or an identity-key module.
 */
export interface AttachmentTransferPorts {
  readonly now: () => number;
  readonly randomBytes: (bytes: Uint8Array) => Uint8Array;
  readonly localPeerId: () => string;
  readonly localSigningKey: () => CryptoKey | null;
  /** True only for an already admitted local contact. */
  readonly isKnownPeer: (peerId: string) => boolean;
  /** Returns a verified known-contact Ed25519 key; null rejects the input. */
  readonly knownPeerSigningKey: (peerId: string) => CryptoKey | null | Promise<CryptoKey | null>;
  /** This is volatile application-capability state, never relay metadata. */
  readonly peerCapabilities: (peerId: string) => ApplicationCapabilities | null;
  /** Seals the exact bytes in the existing HPKE/AAD adapter and starts live transit. */
  readonly send: (request: AttachmentSendRequest) => void | Promise<void>;
  readonly timers: AttachmentTimerPort;
  /** Called only after a known peer's manifest signature and core admission pass. */
  readonly onInboundOffer?: (offer: InboundAttachmentOffer) => boolean | undefined;
  /**
   * Synchronous hand-off of a fully accepted, SHA-256-verified inbound file.
   * The controller never retains these bytes after this callback returns.
   */
  readonly onInboundComplete?: (offer: InboundAttachmentOffer, bytes: Uint8Array) => void;
  readonly onEvent?: (event: AttachmentControllerEvent) => void;
}

export interface AttachmentTimerPort {
  readonly schedule: (delayMs: number, callback: () => void) => unknown;
  readonly cancel: (handle: unknown) => void;
}

export interface AttachmentSendRequest {
  readonly peerId: string;
  /** Relay delivery id only correlates one live forwarding acknowledgement. */
  readonly deliveryId: string;
  /** Raw deterministic CBOR application payload to seal inside the existing HPKE boundary. */
  readonly plaintext: Uint8Array;
}

export type AttachmentOfferResult =
  | { readonly status: "offered"; readonly transferId: string }
  | { readonly status: "rejected"; readonly reason: "unknown_peer" | "unsupported" | "busy" | "unavailable" | "send_failed" };

/** Read-only local admission for a file picker; it never reads a File. */
export type AttachmentOfferAdmission =
  | { readonly status: "ready"; readonly maximumBytes: number }
  | { readonly status: "rejected"; readonly reason: "unknown_peer" | "unsupported" | "busy" | "unavailable" };

export type AttachmentIncomingResult =
  | { readonly status: "handled"; readonly kind: typeof attachmentManifestKind | typeof attachmentDecisionKind | typeof attachmentChunkKind }
  | { readonly status: "ignored"; readonly reason: "invalid_payload" | "invalid_signature" | "unknown_peer" | "busy" | "unsupported" };

export type AttachmentActionResult =
  | { readonly status: "sent" }
  | { readonly status: "rejected"; readonly reason: "unknown_peer" | "unavailable" | "send_failed" | "busy" };

interface InboundTransfer {
  readonly peerId: string;
  readonly registry: AttachmentTransferRegistry;
  readonly transfer: AttachmentTransferState;
  readonly expiry: unknown;
}

interface OutboundTransfer {
  readonly peerId: string;
  readonly registry: AttachmentTransferRegistry;
  readonly transfer: AttachmentTransferState;
  readonly file: File;
  readonly expiry: unknown;
  readonly manifestDeliveryId: string;
  readonly manifestForwardTimeout: unknown;
  readonly outstanding: Map<string, OutstandingChunk>;
  nextChunkIndex: number;
  filling: boolean;
}

interface OutstandingChunk {
  readonly index: number;
  readonly timeout: unknown;
}

/**
 * Owns the bounded, volatile endpoint lifecycle for one tab. It is explicitly
 * not a file store, a resume mechanism, a transport queue, or a relay client.
 */
export class AttachmentTransferController {
  readonly #ports: AttachmentTransferPorts;
  readonly #inbound = new Map<string, InboundTransfer>();
  readonly #outbound = new Map<string, OutboundTransfer>();
  readonly #deliveryToOutbound = new Map<string, OutboundTransfer>();
  readonly #manifestDeliveryToOutbound = new Map<string, OutboundTransfer>();
  readonly #offeringPeers = new Set<string>();
  // Retain only the core's small expiring replay tombstones after a live
  // transfer ends. These maps hold no File, chunk, manifest bytes or timer.
  readonly #inboundRegistries = new Map<string, AttachmentTransferRegistry>();
  readonly #outboundRegistries = new Map<string, AttachmentTransferRegistry>();

  constructor(ports: AttachmentTransferPorts) {
    this.#ports = ports;
  }

  /**
   * Checks only current local state and the peer's volatile application
   * capability. The eventual offer repeats this admission before it reads or
   * hashes a File, so a picker result cannot bypass a changed peer state.
   */
  canOffer(peerId: string): AttachmentOfferAdmission {
    if (!this.#ports.isKnownPeer(peerId)) return { status: "rejected", reason: "unknown_peer" };
    const maximumBytes = this.#maximumOfferBytes(peerId);
    if (maximumBytes === null) return { status: "rejected", reason: "unsupported" };
    if (this.#outbound.has(peerId) || this.#offeringPeers.has(peerId) || this.#activeDirectionCount() + this.#offeringPeers.size >= maximumActiveDirections) {
      return { status: "rejected", reason: "busy" };
    }
    if (this.#ports.localSigningKey() === null || this.#ports.localPeerId() === "") {
      return { status: "rejected", reason: "unavailable" };
    }
    return { status: "ready", maximumBytes };
  }

  /** Builds and signs a relay-sized live offer. It never auto-retries. */
  async offer(peerId: string, file: File): Promise<AttachmentOfferResult> {
    const admission = this.canOffer(peerId);
    if (admission.status !== "ready") return this.#offerRejected(peerId, admission.reason);
    if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > admission.maximumBytes) return this.#offerRejected(peerId, "unsupported");
    const signingKey = this.#ports.localSigningKey();
    if (signingKey === null || this.#ports.localPeerId() === "") return this.#offerRejected(peerId, "unavailable");
    this.#offeringPeers.add(peerId);
    try {
      const now = this.#ports.now();
      const manifest = await createSignedAttachmentManifest({
        transferId: this.#randomToken(16),
        manifestId: this.#randomToken(32),
        issuedAt: now,
        expiresAt: now + maxAttachmentTTLms,
        fileName: file.name,
        mediaType: file.type === "" ? "application/octet-stream" : file.type,
        byteCount: file.size,
        chunkBytes: maxAttachmentChunkBytes,
        chunkCount: Math.ceil(file.size / maxAttachmentChunkBytes),
        sha256: await sha256Base64URL(new Uint8Array(await file.arrayBuffer()))
      }, signingKey);
      if (manifest.byteCount > maxRelayAttachmentBytes) return this.#offerRejected(peerId, "unsupported");
      const registry = this.#registry(peerId, "outbound");
      const opened = registry.open(manifest, now);
      if (opened.status !== "opened") return this.#offerRejected(peerId, opened.status === "busy" ? "busy" : "unsupported");
      const manifestDeliveryId = this.#randomToken(16);
      const outbound: OutboundTransfer = {
        peerId,
        registry,
        transfer: opened.transfer,
        file,
        expiry: this.#ports.timers.schedule(manifest.expiresAt - now, () => { this.#endOutbound(peerId, "expired"); }),
        manifestDeliveryId,
        manifestForwardTimeout: this.#ports.timers.schedule(relayForwardTimeoutMs, () => { this.#endOutbound(peerId, "ack_timeout"); }),
        outstanding: new Map(),
        nextChunkIndex: 0,
        filling: false
      };
      this.#outbound.set(peerId, outbound);
      this.#manifestDeliveryToOutbound.set(manifestDeliveryId, outbound);
      await this.#send(peerId, attachmentManifestKind, encodeAttachmentManifest(manifest), manifestDeliveryId);
      this.#emit("attachment.offer.sent", peerId, "outbound", "accepted");
      return { status: "offered", transferId: manifest.transferId };
    } catch {
      const hadLiveOffer = this.#outbound.has(peerId);
      this.#endOutbound(peerId, "send_failed");
      return hadLiveOffer ? { status: "rejected", reason: "send_failed" } : this.#offerRejected(peerId, "send_failed");
    } finally {
      this.#offeringPeers.delete(peerId);
    }
  }

  /**
   * Processes a post-HPKE raw application payload. Callers must invoke this
   * before legacy UTF-8 compatibility parsing so every attachment kind stays
   * endpoint-only binary traffic.
   */
  async receive(peerId: string, plaintext: Uint8Array): Promise<AttachmentIncomingResult> {
    if (!this.#ports.isKnownPeer(peerId)) return { status: "ignored", reason: "unknown_peer" };
    let payload: ReturnType<typeof decodeApplicationPayload>;
    try {
      payload = decodeApplicationPayload(plaintext);
    } catch {
      return { status: "ignored", reason: "invalid_payload" };
    }
    if (!attachmentKinds.includes(payload.kind as typeof attachmentKinds[number])) {
      return { status: "ignored", reason: "unsupported" };
    }
    try {
      switch (payload.kind) {
        case attachmentManifestKind:
          return await this.#receiveManifest(peerId, payload.body);
        case attachmentDecisionKind:
          return await this.#receiveDecision(peerId, payload.body);
        case attachmentChunkKind:
          return await this.#receiveChunk(peerId, payload.body);
      }
      return { status: "ignored", reason: "unsupported" };
    } catch {
      return { status: "ignored", reason: "invalid_payload" };
    }
  }

  /** Explicit local consent is required before the inbound registry admits chunks. */
  async accept(peerId: string): Promise<AttachmentActionResult> {
    const inbound = this.#inbound.get(peerId);
    if (inbound === undefined) return { status: "rejected", reason: "busy" };
    return this.#sendLocalDecision(peerId, inbound.transfer, "accept", "inbound");
  }

  async reject(peerId: string): Promise<AttachmentActionResult> {
    const inbound = this.#inbound.get(peerId);
    if (inbound === undefined) return { status: "rejected", reason: "busy" };
    return this.#sendLocalDecision(peerId, inbound.transfer, "reject", "inbound");
  }

  /** Cancels local volatile state even if best-effort cancellation transit fails. */
  async cancel(peerId: string, direction: AttachmentDirection): Promise<AttachmentActionResult> {
    const current = direction === "inbound" ? this.#inbound.get(peerId) : this.#outbound.get(peerId);
    if (current === undefined) return { status: "rejected", reason: "busy" };
    return this.#sendLocalDecision(peerId, current.transfer, "cancel", direction);
  }

  /** A terminal live relay-forwarded ACK advances only the owning four-chunk window. */
  onRelayForwarded(deliveryId: string): boolean {
    const manifestOutbound = this.#manifestDeliveryToOutbound.get(deliveryId);
    if (manifestOutbound !== undefined) {
      this.#ports.timers.cancel(manifestOutbound.manifestForwardTimeout);
      this.#manifestDeliveryToOutbound.delete(deliveryId);
      return true;
    }
    const outbound = this.#deliveryToOutbound.get(deliveryId);
    if (outbound === undefined) return false;
    const outstanding = outbound.outstanding.get(deliveryId);
    if (outstanding === undefined) return false;
    this.#ports.timers.cancel(outstanding.timeout);
    outbound.outstanding.delete(deliveryId);
    this.#deliveryToOutbound.delete(deliveryId);
    if (outbound.nextChunkIndex >= outbound.transfer.manifest.chunkCount && outbound.outstanding.size === 0) {
      // This means only every chunk completed one live forwarding attempt; it
      // is not peer receipt, rendering, persistence, or integrity evidence.
      this.#endOutbound(outbound.peerId, "accepted");
    } else {
      void this.#fillWindow(outbound);
    }
    return true;
  }

  /** A relay loss makes all live transfer state unavailable; no re-offer occurs. */
  unavailable(peerId?: string): void {
    if (peerId !== undefined) {
      this.#endInbound(peerId, "unavailable");
      this.#endOutbound(peerId, "unavailable");
      return;
    }
    for (const currentPeerId of [...this.#inbound.keys()]) this.#endInbound(currentPeerId, "disconnected");
    for (const currentPeerId of [...this.#outbound.keys()]) this.#endOutbound(currentPeerId, "disconnected");
  }

  close(): void { this.unavailable(); }

  async #receiveManifest(peerId: string, bytes: Uint8Array): Promise<AttachmentIncomingResult> {
    const manifest = decodeAttachmentManifest(bytes);
    if (!await verifyAttachmentManifest(manifest, await this.#ports.knownPeerSigningKey(peerId))) {
      return { status: "ignored", reason: "invalid_signature" };
    }
    if (this.#inbound.has(peerId) || this.#activeDirectionCount() >= maximumActiveDirections) return { status: "ignored", reason: "busy" };
    const now = this.#ports.now();
    const registry = this.#registry(peerId, "inbound");
    const opened = registry.open(manifest, now);
    if (opened.status !== "opened") return { status: "ignored", reason: opened.status === "busy" ? "busy" : "invalid_payload" };
    this.#inbound.set(peerId, {
      peerId,
      registry,
      transfer: opened.transfer,
      expiry: this.#ports.timers.schedule(manifest.expiresAt - now, () => { this.#endInbound(peerId, "expired"); })
    });
    try {
      if (this.#ports.onInboundOffer?.({ peerId, manifest: opened.transfer.manifest }) === false) {
        this.#endInbound(peerId, "busy");
        return { status: "ignored", reason: "busy" };
      }
    } catch {
      this.#endInbound(peerId, "send_failed");
      return { status: "ignored", reason: "busy" };
    }
    this.#emit("attachment.offer.received", peerId, "inbound", "accepted");
    return { status: "handled", kind: attachmentManifestKind };
  }

  async #receiveDecision(peerId: string, bytes: Uint8Array): Promise<AttachmentIncomingResult> {
    const decision = decodeAttachmentDecision(bytes);
    if (!await verifyAttachmentDecision(decision, await this.#ports.knownPeerSigningKey(peerId))) {
      return { status: "ignored", reason: "invalid_signature" };
    }
    const outbound = this.#outbound.get(peerId);
    const inbound = this.#inbound.get(peerId);
    if (outbound !== undefined) {
      const result = outbound.transfer.receiveDecision(decision, this.#ports.now());
      if (result.status === "accepted") {
        this.#emit("attachment.transfer.accepted", peerId, "outbound", "accepted");
        void this.#fillWindow(outbound);
      } else if (result.status === "rejected") {
        this.#endOutbound(peerId, "rejected");
      } else if (result.status === "cancelled" || result.status === "expired" || result.status === "aborted") {
        this.#endOutbound(peerId, result.status === "cancelled" ? "cancelled" : "invalid_payload");
      }
      return { status: "handled", kind: attachmentDecisionKind };
    }
    if (inbound !== undefined && decision.kind === "cancel") {
      const result = inbound.transfer.cancel(decision, this.#ports.now());
      if (result.status === "cancelled") this.#endInbound(peerId, "cancelled");
      return { status: "handled", kind: attachmentDecisionKind };
    }
    return { status: "ignored", reason: "invalid_payload" };
  }

  async #receiveChunk(peerId: string, bytes: Uint8Array): Promise<AttachmentIncomingResult> {
    const inbound = this.#inbound.get(peerId);
    if (inbound === undefined) return { status: "ignored", reason: "busy" };
    const chunk = decodeAttachmentChunk(bytes);
    const result = await inbound.transfer.receiveChunk(chunk, this.#ports.now());
    if (result.status === "completed") {
      // Core returns `completed` only after the receiver accepted the offer,
      // all chunks arrived, and the complete SHA-256 digest matched. Hand the
      // volatile bytes off before releasing this controller's inbound state.
      // A UI callback cannot interfere with endpoint cleanup or transit.
      try {
        this.#ports.onInboundComplete?.({ peerId, manifest: inbound.transfer.manifest }, result.bytes);
      } catch { /* UI delivery is optional and must not retain transport state. */ }
      this.#endInbound(peerId, "accepted");
    } else if (result.status === "aborted" || result.status === "expired") {
      this.#endInbound(peerId, result.reason === "integrity_failed" ? "integrity_failed" : "invalid_payload");
    }
    return { status: "handled", kind: attachmentChunkKind };
  }

  async #sendLocalDecision(peerId: string, transfer: AttachmentTransferState, kind: AttachmentDecision["kind"], direction: AttachmentDirection): Promise<AttachmentActionResult> {
    if (!this.#ports.isKnownPeer(peerId)) return { status: "rejected", reason: "unknown_peer" };
    const signingKey = this.#ports.localSigningKey();
    if (signingKey === null) return { status: "rejected", reason: "unavailable" };
    const now = this.#ports.now();
    const manifest = transfer.manifest;
    try {
      const decision = await createSignedAttachmentDecision({
        kind,
        transferId: manifest.transferId,
        manifestId: manifest.manifestId,
        issuedAt: now,
        expiresAt: Math.min(manifest.expiresAt, now + maxAttachmentTTLms)
      }, signingKey);
      if (kind === "accept") transfer.accept(decision, now);
      else if (kind === "reject") {
        // The core models a remote reject on the outbound side. For local
        // receiver refusal, releasing state before transit is the relevant
        // invariant; no chunk can be admitted while phase remains offered.
      } else transfer.cancel(decision, now);
      await this.#send(peerId, attachmentDecisionKind, encodeAttachmentDecision(decision));
      if (kind === "accept") {
        this.#emit("attachment.transfer.accepted", peerId, direction, "accepted");
      } else if (direction === "inbound") {
        this.#endInbound(peerId, kind === "reject" ? "rejected" : "cancelled");
      } else {
        this.#endOutbound(peerId, "cancelled");
      }
      return { status: "sent" };
    } catch {
      if (direction === "inbound") this.#endInbound(peerId, "send_failed");
      else this.#endOutbound(peerId, "send_failed");
      return { status: "rejected", reason: "send_failed" };
    }
  }

  async #fillWindow(outbound: OutboundTransfer): Promise<void> {
    if (outbound.filling || this.#outbound.get(outbound.peerId) !== outbound) return;
    outbound.filling = true;
    try {
      while (outbound.outstanding.size < outboundWindowSize && outbound.nextChunkIndex < outbound.transfer.manifest.chunkCount) {
        const index = outbound.nextChunkIndex;
        outbound.nextChunkIndex += 1;
        const manifest = outbound.transfer.manifest;
        const start = index * manifest.chunkBytes;
        const chunk: AttachmentChunk = {
          version: attachmentVersion,
          transferId: manifest.transferId,
          manifestId: manifest.manifestId,
          index,
          bytes: new Uint8Array(await outbound.file.slice(start, Math.min(start + manifest.chunkBytes, manifest.byteCount)).arrayBuffer())
        };
        const admitted = outbound.transfer.admitOutboundChunk(chunk, this.#ports.now());
        if (admitted.status !== "chunk_stored") {
          this.#endOutbound(outbound.peerId, "invalid_payload");
          return;
        }
        const deliveryId = this.#randomToken(16);
        const timeout = this.#ports.timers.schedule(relayForwardTimeoutMs, () => { this.#endOutbound(outbound.peerId, "ack_timeout"); });
        outbound.outstanding.set(deliveryId, { index, timeout });
        this.#deliveryToOutbound.set(deliveryId, outbound);
        try {
          await this.#send(outbound.peerId, attachmentChunkKind, encodeAttachmentChunk(chunk), deliveryId);
        } catch {
          this.#endOutbound(outbound.peerId, "send_failed");
          return;
        }
      }
    } finally {
      outbound.filling = false;
    }
  }

  async #send(peerId: string, kind: typeof attachmentKinds[number], body: Uint8Array, deliveryId: string = this.#randomToken(16)): Promise<void> {
    const plaintext = encodeApplicationPayload({
      version: attachmentApplicationVersion,
      kind,
      messageId: this.#randomToken(16),
      body
    });
    await this.#ports.send({ peerId, deliveryId, plaintext });
  }

  #registry(peerId: string, direction: AttachmentDirection): AttachmentTransferRegistry {
    const registries = direction === "inbound" ? this.#inboundRegistries : this.#outboundRegistries;
    const existing = registries.get(peerId);
    if (existing !== undefined) return existing;
    while (registries.size >= maximumRememberedPeers) {
      const oldest = registries.keys().next().value;
      if (oldest === undefined) break;
      registries.delete(oldest);
    }
    const created = new AttachmentTransferRegistry(direction, { sha256Base64URL }, {
      maximumTransferBytes: maxRelayAttachmentBytes,
      maximumReorderChunks: 64,
      maximumRememberedTransfers: 16
    });
    registries.set(peerId, created);
    return created;
  }

  #maximumOfferBytes(peerId: string): number | null {
    const capabilities = this.#ports.peerCapabilities(peerId);
    if (capabilities !== null && capabilities.attachmentMode === "receiver-accept" &&
      capabilities.applicationVersions.includes(attachmentApplicationVersion) &&
      attachmentKinds.every((kind) => capabilities.kinds.includes(kind)) &&
      Number.isSafeInteger(capabilities.maxRelayAttachmentBytes) && capabilities.maxRelayAttachmentBytes > 0) {
      return Math.min(capabilities.maxRelayAttachmentBytes, maxRelayAttachmentBytes);
    }
    return null;
  }

  #activeDirectionCount(): number { return this.#inbound.size + this.#outbound.size; }

  #endInbound(peerId: string, reason: AttachmentControllerReason): void {
    const inbound = this.#inbound.get(peerId);
    if (inbound === undefined) return;
    const manifest = inbound.transfer.manifest;
    this.#ports.timers.cancel(inbound.expiry);
    inbound.transfer.abort();
    inbound.registry.expire(this.#ports.now());
    this.#inbound.delete(peerId);
    this.#emit("attachment.transfer.ended", peerId, "inbound", reason, manifest);
  }

  #endOutbound(peerId: string, reason: AttachmentControllerReason): void {
    const outbound = this.#outbound.get(peerId);
    if (outbound === undefined) return;
    const manifest = outbound.transfer.manifest;
    this.#ports.timers.cancel(outbound.expiry);
    this.#ports.timers.cancel(outbound.manifestForwardTimeout);
    this.#manifestDeliveryToOutbound.delete(outbound.manifestDeliveryId);
    for (const [deliveryId, outstanding] of outbound.outstanding) {
      this.#ports.timers.cancel(outstanding.timeout);
      this.#deliveryToOutbound.delete(deliveryId);
    }
    outbound.outstanding.clear();
    outbound.transfer.abort();
    outbound.registry.expire(this.#ports.now());
    this.#outbound.delete(peerId);
    this.#emit("attachment.transfer.ended", peerId, "outbound", reason, manifest);
  }

  #offerRejected(peerId: string, reason: Extract<AttachmentOfferResult, { readonly status: "rejected" }> ["reason"]): AttachmentOfferResult {
    this.#emit("attachment.transfer.ended", peerId, "outbound", reason);
    return { status: "rejected", reason };
  }

  #emit(event: AttachmentControllerEvent["event"], peerId: string, direction: AttachmentDirection, reason: AttachmentControllerReason, manifest?: AttachmentManifest): void {
    const metadata = manifest === undefined ? {} : { fileName: manifest.fileName, byteCount: manifest.byteCount };
    try { this.#ports.onEvent?.({ event, peerId, direction, reason, ...metadata }); } catch { /* Diagnostics must not affect transit. */ }
  }

  #randomToken(length: number): string {
    const bytes = new Uint8Array(length);
    const filled = this.#ports.randomBytes(bytes);
    if (filled.byteLength !== length) throw new Error("invalid random bytes");
    return encodeBase64URL(filled);
  }
}

/** Browser-WebCrypto signing helper for exact canonical manifest bytes. */
export async function createSignedAttachmentManifest(
  value: Omit<AttachmentManifest, "version" | "signature">,
  privateKey: CryptoKey
): Promise<AttachmentManifest> {
  const unsigned: AttachmentManifest = { ...value, version: attachmentVersion, signature: new Uint8Array(64) };
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, arrayBuffer(attachmentManifestSigningBytes(unsigned))));
  return { ...unsigned, signature };
}

/** Browser-WebCrypto signing helper for exact canonical decision bytes. */
export async function createSignedAttachmentDecision(
  value: Omit<AttachmentDecision, "version" | "signature">,
  privateKey: CryptoKey
): Promise<AttachmentDecision> {
  const unsigned: AttachmentDecision = { ...value, version: attachmentVersion, signature: new Uint8Array(64) };
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, arrayBuffer(attachmentDecisionSigningBytes(unsigned))));
  return { ...unsigned, signature };
}

export async function verifyAttachmentManifest(manifest: AttachmentManifest, publicKey: CryptoKey | null): Promise<boolean> {
  if (publicKey === null) return false;
  try { return await crypto.subtle.verify("Ed25519", publicKey, arrayBuffer(manifest.signature), arrayBuffer(attachmentManifestSigningBytes(manifest))); } catch { return false; }
}

export async function verifyAttachmentDecision(decision: AttachmentDecision, publicKey: CryptoKey | null): Promise<boolean> {
  if (publicKey === null) return false;
  try { return await crypto.subtle.verify("Ed25519", publicKey, arrayBuffer(decision.signature), arrayBuffer(attachmentDecisionSigningBytes(decision))); } catch { return false; }
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
