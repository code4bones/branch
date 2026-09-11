import {
  applicationPayloadVersion,
  capabilityAllowsImageTransfer,
  capabilityAllowsInlineImage,
  decodeApplicationPayload,
  decodeInlineImage,
  decodeImageTransferChunk,
  decodeImageTransferManifest,
  encodeApplicationPayload,
  encodeBase64URL,
  encodeImageTransferChunk,
  encodeImageTransferManifest,
  encodeInlineImage,
  hasRasterImageMagic,
  imageInlineKind,
  imageMessageVersion,
  imageTransferChunkKind,
  imageTransferManifestKind,
  imageTransferManifestSigningBytes,
  imageTransferVersion,
  ImageTransferReassemblyRegistry,
  maxImageTransferChunkBytes,
  maxImageTransferTTLms,
  sha256Base64URL,
  validateImageManifestForMessage,
  type ImageCapabilities,
  type ImageRoute,
  type ImageTransferManifest,
  type RasterImageMediaType
} from "@code4bones/branch-core";

/** Exact application-payload kinds for the endpoint-only auto-rendered image draft. */
export { imageInlineKind, imageTransferManifestKind, imageTransferChunkKind };

const imageKinds = [imageInlineKind, imageTransferManifestKind, imageTransferChunkKind] as const;

export type ImageTransferReason =
  | "accepted"
  | "unknown_peer"
  | "unsupported"
  | "busy"
  | "unavailable"
  | "invalid_payload"
  | "invalid_signature"
  | "integrity_failed"
  | "expired"
  | "send_failed";

export interface ImageTransferTimerPort {
  readonly schedule: (delayMs: number, callback: () => void) => unknown;
  readonly cancel: (handle: unknown) => void;
}

export interface ImageTransferSendRequest {
  readonly peerId: string;
  /** Fresh delivery identity for one live encrypted ENVELOPE forwarding attempt. */
  readonly deliveryId: string;
  /** Raw deterministic-CBOR application payload for the existing HPKE/AAD adapter. */
  readonly plaintext: Uint8Array;
}

export interface VerifiedImageMessage {
  readonly peerId: string;
  readonly messageId: string;
  readonly mediaType: RasterImageMediaType;
  readonly width: number;
  readonly height: number;
  /** One detached copy; the controller drops its temporary transfer state first. */
  readonly bytes: Uint8Array;
  readonly caption?: string;
  readonly replyToMessageId?: string;
}

export interface ImageTransferEvent {
  readonly event: "image.inline.received" | "image.transfer.started" | "image.transfer.ended";
  readonly peerId: string;
  readonly direction: "inbound" | "outbound";
  readonly reason: ImageTransferReason;
  /** Bounded endpoint diagnostics only; never pixels, dimensions, hashes, or identity tokens. */
  readonly sizeBucket?: "up_to_3k" | "up_to_64k" | "up_to_1m" | "up_to_4m" | "over_4m";
}

export interface ImageTransferPorts {
  readonly now: () => number;
  readonly randomBytes: (bytes: Uint8Array) => Uint8Array;
  readonly localSigningKey: () => CryptoKey | null;
  readonly isKnownPeer: (peerId: string) => boolean;
  readonly knownPeerSigningKey: (peerId: string) => CryptoKey | null | Promise<CryptoKey | null>;
  /** The remote peer's current, verified signed capability for outbound media. */
  readonly peerCapabilities: (peerId: string) => ImageCapabilities | null;
  /**
   * The local current capability actually advertised to this peer. Returning
   * null makes inbound automatic image admission unavailable.
   */
  readonly inboundCapabilities: (peerId: string) => ImageCapabilities | null;
  readonly send: (request: ImageTransferSendRequest) => void | Promise<void>;
  readonly timers: ImageTransferTimerPort;
  /** Must decode the raster and confirm actual MIME, dimensions and no animation. */
  readonly verifyRaster: (image: Omit<VerifiedImageMessage, "peerId" | "messageId">) => boolean | Promise<boolean>;
  /** Called only after all receiver-owned admission checks have passed. */
  readonly onImage: (image: VerifiedImageMessage) => void | Promise<void>;
  readonly onEvent?: (event: ImageTransferEvent) => void;
}

export type ImageSendResult =
  | { readonly status: "sent"; readonly messageId: string; readonly mode: "inline" | "transfer" }
  | { readonly status: "rejected"; readonly reason: "unknown_peer" | "unsupported" | "busy" | "unavailable" | "send_failed" };

export type ImageIncomingResult =
  | { readonly status: "handled"; readonly kind: typeof imageInlineKind | typeof imageTransferManifestKind | typeof imageTransferChunkKind }
  | { readonly status: "ignored"; readonly reason: "unknown_peer" | "unsupported" | "busy" | "invalid_payload" | "invalid_signature" };

/**
 * A bounded live image-transfer adapter. It deliberately has no attachment
 * decision method, relay ACK window, retry queue, persistence, or UI import.
 * A manifest immediately authorizes chunk admission only if this endpoint's
 * own still-current signed image capability does so.
 */
export class ImageTransferController {
  readonly #ports: ImageTransferPorts;
  // Pure chunk identity, ordering, duplicate and digest state lives in core.
  // This adapter owns only browser-side expiry scheduling and image projection.
  readonly #inbound = new ImageTransferReassemblyRegistry({ sha256Base64URL });
  readonly #inboundExpiry = new Map<string, unknown>();
  readonly #inboundRoutes = new Map<string, ImageRoute>();
  readonly #inboundSizes = new Map<string, number>();
  readonly #outboundPeers = new Set<string>();

  constructor(ports: ImageTransferPorts) {
    this.#ports = ports;
  }

  async sendImage(options: {
    readonly peerId: string;
    readonly route: ImageRoute;
    /** Caller-owned application identity, retained across a user-initiated live retry. */
    readonly messageId?: string;
    readonly mediaType: RasterImageMediaType;
    readonly width: number;
    readonly height: number;
    readonly bytes: Uint8Array;
    readonly caption?: string;
    readonly replyToMessageId?: string;
  }): Promise<ImageSendResult> {
    if (!this.#ports.isKnownPeer(options.peerId)) return { status: "rejected", reason: "unknown_peer" };
    if (!hasRasterImageMagic(options.mediaType, options.bytes)) return { status: "rejected", reason: "unsupported" };
    const capabilities = this.#ports.peerCapabilities(options.peerId);
    if (capabilities === null) return { status: "rejected", reason: "unsupported" };
    if (this.#outboundPeers.has(options.peerId)) return { status: "rejected", reason: "busy" };
    const signingKey = this.#ports.localSigningKey();
    if (signingKey === null) return { status: "rejected", reason: "unavailable" };

    this.#outboundPeers.add(options.peerId);
    try {
      const inline = {
        version: imageMessageVersion,
        mediaType: options.mediaType,
        width: options.width,
        height: options.height,
        bytes: options.bytes,
        ...(options.caption === undefined ? {} : { caption: options.caption }),
        ...(options.replyToMessageId === undefined ? {} : { replyToMessageId: options.replyToMessageId })
      } as const;
      let inlineBody: Uint8Array | null = null;
      try { inlineBody = encodeInlineImage(inline); } catch { /* Falls through to signed live transfer. */ }
      if (inlineBody !== null && capabilityAllowsInlineImage(capabilities, inline)) {
        const messageId = options.messageId ?? this.#token(16);
        await this.#send(options.peerId, messageId, imageInlineKind, inlineBody);
        this.#emit("image.transfer.ended", options.peerId, "outbound", "accepted", options.bytes.byteLength);
        return { status: "sent", messageId, mode: "inline" };
      }
      return await this.#sendTransfer(options, capabilities, signingKey);
    } catch {
      this.#emit("image.transfer.ended", options.peerId, "outbound", "send_failed");
      return { status: "rejected", reason: "send_failed" };
    } finally {
      this.#outboundPeers.delete(options.peerId);
    }
  }

  /** Invoke after HPKE opening and before legacy text compatibility parsing. */
  async receive(peerId: string, plaintext: Uint8Array, route: ImageRoute = "relay"): Promise<ImageIncomingResult> {
    if (!this.#ports.isKnownPeer(peerId)) return { status: "ignored", reason: "unknown_peer" };
    let payload: ReturnType<typeof decodeApplicationPayload>;
    try { payload = decodeApplicationPayload(plaintext); } catch { return { status: "ignored", reason: "invalid_payload" }; }
    if (!imageKinds.includes(payload.kind as typeof imageKinds[number])) return { status: "ignored", reason: "unsupported" };
    try {
      switch (payload.kind) {
        case imageInlineKind: return await this.#receiveInline(peerId, payload.messageId, payload.body);
        case imageTransferManifestKind: return await this.#receiveManifest(peerId, route, payload.messageId, payload.body);
        case imageTransferChunkKind: return await this.#receiveChunk(peerId, payload.body);
      }
    } catch {
      return { status: "ignored", reason: "invalid_payload" };
    }
    return { status: "ignored", reason: "unsupported" };
  }

  close(): void {
    for (const expiry of this.#inboundExpiry.values()) this.#ports.timers.cancel(expiry);
    this.#inboundExpiry.clear();
    this.#inboundRoutes.clear();
    this.#inboundSizes.clear();
    this.#inbound.clear();
    this.#outboundPeers.clear();
  }

  async #sendTransfer(
    options: { readonly peerId: string; readonly route: ImageRoute; readonly messageId?: string; readonly mediaType: RasterImageMediaType; readonly width: number; readonly height: number; readonly bytes: Uint8Array; readonly caption?: string; readonly replyToMessageId?: string },
    capabilities: ImageCapabilities,
    signingKey: CryptoKey
  ): Promise<ImageSendResult> {
    const now = this.#ports.now();
    const messageId = options.messageId ?? this.#token(16);
    const unsigned: Omit<ImageTransferManifest, "signature"> = {
      version: imageTransferVersion,
      transferId: this.#token(16),
      manifestId: this.#token(32),
      messageId,
      issuedAt: now,
      expiresAt: now + maxImageTransferTTLms,
      mediaType: options.mediaType,
      width: options.width,
      height: options.height,
      byteCount: options.bytes.byteLength,
      chunkBytes: maxImageTransferChunkBytes,
      chunkCount: Math.ceil(options.bytes.byteLength / maxImageTransferChunkBytes),
      sha256: await sha256Base64URL(options.bytes),
      ...(options.caption === undefined ? {} : { caption: options.caption }),
      ...(options.replyToMessageId === undefined ? {} : { replyToMessageId: options.replyToMessageId })
    };
    const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", signingKey, buffer(imageTransferManifestSigningBytes({ ...unsigned, signature: new Uint8Array(64) }))));
    const manifest: ImageTransferManifest = { ...unsigned, signature };
    if (!capabilityAllowsImageTransfer(capabilities, manifest, options.route)) return { status: "rejected", reason: "unsupported" };
    await this.#send(options.peerId, messageId, imageTransferManifestKind, encodeImageTransferManifest(manifest));
    this.#emit("image.transfer.started", options.peerId, "outbound", "accepted", manifest.byteCount);
    for (let index = 0; index < manifest.chunkCount; index += 1) {
      if (this.#ports.now() >= manifest.expiresAt) return { status: "rejected", reason: "send_failed" };
      const start = index * manifest.chunkBytes;
      await this.#send(options.peerId, this.#token(16), imageTransferChunkKind, encodeImageTransferChunk({
        version: imageTransferVersion,
        transferId: manifest.transferId,
        manifestId: manifest.manifestId,
        index,
        bytes: options.bytes.slice(start, Math.min(start + manifest.chunkBytes, options.bytes.byteLength))
      }));
    }
    this.#emit("image.transfer.ended", options.peerId, "outbound", "accepted", manifest.byteCount);
    return { status: "sent", messageId, mode: "transfer" };
  }

  async #receiveInline(peerId: string, messageId: string, body: Uint8Array): Promise<ImageIncomingResult> {
    const image = decodeInlineImage(body);
    const capabilities = this.#ports.inboundCapabilities(peerId);
    if (capabilities === null || !capabilityAllowsInlineImage(capabilities, image)) return { status: "ignored", reason: "unsupported" };
    if (!hasRasterImageMagic(image.mediaType, image.bytes) || !await this.#verifyRaster(image)) return { status: "ignored", reason: "invalid_payload" };
    await this.#ports.onImage({ peerId, messageId, mediaType: image.mediaType, width: image.width, height: image.height, bytes: copy(image.bytes), ...(image.caption === undefined ? {} : { caption: image.caption }), ...(image.replyToMessageId === undefined ? {} : { replyToMessageId: image.replyToMessageId }) });
    this.#emit("image.inline.received", peerId, "inbound", "accepted", image.bytes.byteLength);
    return { status: "handled", kind: imageInlineKind };
  }

  async #receiveManifest(peerId: string, route: ImageRoute, messageId: string, body: Uint8Array): Promise<ImageIncomingResult> {
    const manifest = decodeImageTransferManifest(body);
    validateImageManifestForMessage(manifest, messageId);
    const capabilities = this.#ports.inboundCapabilities(peerId);
    if (capabilities === null || !capabilityAllowsImageTransfer(capabilities, manifest, route)) return { status: "ignored", reason: "unsupported" };
    if (!await this.#verifyManifest(peerId, manifest)) return { status: "ignored", reason: "invalid_signature" };
    const now = this.#ports.now();
    if (now >= manifest.expiresAt) return { status: "ignored", reason: "invalid_payload" };
    const opened = this.#inbound.open(peerId, manifest, now);
    if (opened.status === "busy") return { status: "ignored", reason: "busy" };
    if (opened.status !== "opened" && opened.status !== "duplicate_manifest") return { status: "ignored", reason: "invalid_payload" };
    if (opened.status === "opened") {
      this.#inboundRoutes.set(peerId, route);
      this.#inboundSizes.set(peerId, manifest.byteCount);
      this.#scheduleInboundExpiry(peerId, manifest.expiresAt - now);
      this.#emit("image.transfer.started", peerId, "inbound", "accepted", manifest.byteCount);
    }
    return { status: "handled", kind: imageTransferManifestKind };
  }

  async #receiveChunk(peerId: string, body: Uint8Array): Promise<ImageIncomingResult> {
    const chunk = decodeImageTransferChunk(body);
    const reassembled = await this.#inbound.receiveChunk(peerId, chunk, this.#ports.now());
    if (reassembled.status === "chunk_stored" || reassembled.status === "duplicate_chunk") return { status: "handled", kind: imageTransferChunkKind };
    if (reassembled.status !== "completed") {
      this.#clearInboundExpiry(peerId);
      this.#inboundRoutes.delete(peerId);
      this.#inboundSizes.delete(peerId);
      if (reassembled.status === "expired") {
        this.#emit("image.transfer.ended", peerId, "inbound", "expired");
        return { status: "ignored", reason: "unsupported" };
      }
      if (reassembled.status === "ignored") return { status: "ignored", reason: "unsupported" };
      this.#emit("image.transfer.ended", peerId, "inbound", "integrity_failed");
      return { status: "ignored", reason: "invalid_payload" };
    }
    this.#clearInboundExpiry(peerId);
    const { bytes: complete, manifest } = reassembled;
    const route = this.#inboundRoutes.get(peerId);
    this.#inboundRoutes.delete(peerId);
    this.#inboundSizes.delete(peerId);
    const capability = this.#ports.inboundCapabilities(peerId);
    if (route === undefined || capability === null || !capabilityAllowsImageTransfer(capability, manifest, route) ||
      !hasRasterImageMagic(manifest.mediaType, complete) ||
      !await this.#verifyRaster({ mediaType: manifest.mediaType, width: manifest.width, height: manifest.height, bytes: complete })) {
      this.#emit("image.transfer.ended", peerId, "inbound", "integrity_failed", manifest.byteCount);
      return { status: "ignored", reason: "invalid_payload" };
    }
    await this.#ports.onImage({ peerId, messageId: manifest.messageId, mediaType: manifest.mediaType, width: manifest.width, height: manifest.height, bytes: complete, ...(manifest.caption === undefined ? {} : { caption: manifest.caption }), ...(manifest.replyToMessageId === undefined ? {} : { replyToMessageId: manifest.replyToMessageId }) });
    this.#emit("image.transfer.ended", peerId, "inbound", "accepted", complete.byteLength);
    return { status: "handled", kind: imageTransferChunkKind };
  }

  async #verifyManifest(peerId: string, manifest: ImageTransferManifest): Promise<boolean> {
    try {
      const key = await this.#ports.knownPeerSigningKey(peerId);
      return key !== null && await crypto.subtle.verify("Ed25519", key, buffer(manifest.signature), buffer(imageTransferManifestSigningBytes(manifest)));
    } catch { return false; }
  }

  async #verifyRaster(image: { readonly mediaType: RasterImageMediaType; readonly width: number; readonly height: number; readonly bytes: Uint8Array }): Promise<boolean> {
    try { return await this.#ports.verifyRaster(image); } catch { return false; }
  }

  async #send(peerId: string, messageId: string, kind: string, body: Uint8Array): Promise<void> {
    const plaintext = encodeApplicationPayload({ version: applicationPayloadVersion, kind, messageId, body });
    await this.#ports.send({ peerId, deliveryId: this.#token(16), plaintext });
  }

  #scheduleInboundExpiry(peerId: string, delayMs: number): void {
    this.#clearInboundExpiry(peerId);
    this.#inboundExpiry.set(peerId, this.#ports.timers.schedule(delayMs, () => {
      this.#inbound.expire(this.#ports.now());
      this.#inboundRoutes.delete(peerId);
      const byteCount = this.#inboundSizes.get(peerId);
      this.#inboundSizes.delete(peerId);
      this.#inboundExpiry.delete(peerId);
      if (byteCount !== undefined) this.#emit("image.transfer.ended", peerId, "inbound", "expired", byteCount);
    }));
  }

  #clearInboundExpiry(peerId: string): void {
    const expiry = this.#inboundExpiry.get(peerId);
    if (expiry !== undefined) this.#ports.timers.cancel(expiry);
    this.#inboundExpiry.delete(peerId);
  }

  #token(size: number): string {
    return encodeBase64URL(this.#ports.randomBytes(new Uint8Array(size)));
  }

  #emit(event: ImageTransferEvent["event"], peerId: string, direction: ImageTransferEvent["direction"], reason: ImageTransferReason, byteCount?: number): void {
    try {
      this.#ports.onEvent?.(byteCount === undefined ? { event, peerId, direction, reason } : { event, peerId, direction, reason, sizeBucket: imageSizeBucket(byteCount) });
    } catch { /* Optional observation boundary. */ }
  }
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

function copy(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function imageSizeBucket(byteCount: number): NonNullable<ImageTransferEvent["sizeBucket"]> {
  if (byteCount <= 3_072) return "up_to_3k";
  if (byteCount <= 64 * 1024) return "up_to_64k";
  if (byteCount <= 1024 * 1024) return "up_to_1m";
  if (byteCount <= 4 * 1024 * 1024) return "up_to_4m";
  return "over_4m";
}
