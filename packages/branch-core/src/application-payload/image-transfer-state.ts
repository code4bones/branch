import {
  maxImageDirectBytes,
  maxImageTransferChunks,
  type ImageTransferChunk,
  type ImageTransferManifest,
  validateImageTransferChunkForManifest,
  validateImageTransferManifest
} from "./image.js";

/** Endpoint-owned digest adapter. It has no transport, clock, DOM, or storage role. */
export interface ImageTransferDigestPort {
  sha256Base64URL(bytes: Uint8Array): Promise<string>;
}

export type ImageTransferReassemblyFailure =
  | "expired"
  | "invalid_manifest"
  | "no_transfer"
  | "invalid_chunk"
  | "reorder_limit"
  | "conflicting_duplicate"
  | "integrity_failed"
  | "digest_failed";

export type ImageTransferReassemblyResult =
  | { readonly status: "opened" | "duplicate_manifest" | "chunk_stored" | "duplicate_chunk" }
  | { readonly status: "completed"; readonly bytes: Uint8Array; readonly manifest: ImageTransferManifest }
  | { readonly status: "busy" | "replayed" | "ignored" | "aborted" | "expired"; readonly reason: ImageTransferReassemblyFailure };

export interface ImageTransferReassemblySnapshot {
  readonly peerId: string;
  readonly transferId: string;
  readonly manifestId: string;
  readonly receivedChunks: number;
  readonly receivedBytes: number;
  readonly nextMissingIndex: number;
}

export interface ImageTransferReassemblyOptions {
  /** Local admission ceiling, never a relay quota or storage allocation promise. */
  readonly maximumTransferBytes?: number;
  /** Maximum chunk distance ahead of the first missing index. */
  readonly maximumReorderChunks?: number;
  /** Bounded concurrent inbound transfers across this endpoint-owned registry. */
  readonly maximumActiveTransfers?: number;
  /** Bounded local replay memory, retained only until each manifest expiry. */
  readonly maximumRememberedTransfers?: number;
}

/**
 * Pure, bounded reassembly state for one already-authenticated image manifest.
 * The caller owns signature verification, capability policy, timers, raster
 * decoding, projection, and storage. `now` and digest are explicit ports so
 * this state has no browser, network, or clock dependency.
 */
export class ImageTransferReassembly {
  readonly #peerId: string;
  readonly #manifest: ImageTransferManifest;
  readonly #digest: ImageTransferDigestPort;
  readonly #maximumReorderChunks: number;
  readonly #chunks = new Map<number, Uint8Array>();
  #receivedBytes = 0;
  #nextMissingIndex = 0;
  #phase: "active" | "aborted" | "expired" | "completed" = "active";

  private constructor(peerId: string, manifest: ImageTransferManifest, digest: ImageTransferDigestPort, maximumReorderChunks: number) {
    this.#peerId = peerId;
    this.#manifest = copyManifest(manifest);
    this.#digest = digest;
    this.#maximumReorderChunks = maximumReorderChunks;
  }

  static open(peerId: string, manifest: ImageTransferManifest, digest: ImageTransferDigestPort, options: ImageTransferReassemblyOptions, now: number): ImageTransferReassembly {
    validateOptions(options);
    validateImageTransferManifest(manifest);
    if (!validPeerId(peerId)) throw new Error("invalid image transfer peer");
    if (!Number.isSafeInteger(now) || now >= manifest.expiresAt) throw new Error("image transfer is expired");
    const maximumTransferBytes = options.maximumTransferBytes ?? maxImageDirectBytes;
    if (manifest.byteCount > maximumTransferBytes) throw new Error("image transfer exceeds local limit");
    return new ImageTransferReassembly(peerId, manifest, digest, options.maximumReorderChunks ?? 64);
  }

  get terminal(): boolean { return this.#phase !== "active"; }
  get expiresAt(): number { return this.#manifest.expiresAt; }
  get key(): string { return transferKey(this.#peerId, this.#manifest); }

  matchesManifest(manifest: ImageTransferManifest): boolean {
    try {
      validateImageTransferManifest(manifest);
      return manifest.transferId === this.#manifest.transferId
        && manifest.manifestId === this.#manifest.manifestId
        && bytesEqual(manifest.signature, this.#manifest.signature)
        && manifest.messageId === this.#manifest.messageId
        && manifest.issuedAt === this.#manifest.issuedAt
        && manifest.expiresAt === this.#manifest.expiresAt
        && manifest.mediaType === this.#manifest.mediaType
        && manifest.width === this.#manifest.width
        && manifest.height === this.#manifest.height
        && manifest.byteCount === this.#manifest.byteCount
        && manifest.chunkBytes === this.#manifest.chunkBytes
        && manifest.chunkCount === this.#manifest.chunkCount
        && manifest.sha256 === this.#manifest.sha256
        && manifest.caption === this.#manifest.caption
        && manifest.replyToMessageId === this.#manifest.replyToMessageId;
    } catch { return false; }
  }

  snapshot(): ImageTransferReassemblySnapshot {
    return {
      peerId: this.#peerId,
      transferId: this.#manifest.transferId,
      manifestId: this.#manifest.manifestId,
      receivedChunks: this.#chunks.size,
      receivedBytes: this.#receivedBytes,
      nextMissingIndex: this.#nextMissingIndex
    };
  }

  async receiveChunk(chunk: ImageTransferChunk, now: number): Promise<ImageTransferReassemblyResult> {
    if (this.#expire(now)) return { status: "expired", reason: "expired" };
    try { validateImageTransferChunkForManifest(chunk, this.#manifest); } catch { return this.#abort("invalid_chunk"); }
    const previous = this.#chunks.get(chunk.index);
    if (previous !== undefined) return bytesEqual(previous, chunk.bytes) ? { status: "duplicate_chunk" } : this.#abort("conflicting_duplicate");
    if (chunk.index - this.#nextMissingIndex > this.#maximumReorderChunks) return this.#abort("reorder_limit");

    const bytes = new Uint8Array(chunk.bytes);
    this.#chunks.set(chunk.index, bytes);
    this.#receivedBytes += bytes.byteLength;
    while (this.#chunks.has(this.#nextMissingIndex)) this.#nextMissingIndex += 1;
    if (this.#chunks.size !== this.#manifest.chunkCount) return { status: "chunk_stored" };
    if (this.#receivedBytes !== this.#manifest.byteCount) return this.#abort("invalid_chunk");

    const complete = new Uint8Array(this.#manifest.byteCount);
    let offset = 0;
    for (let index = 0; index < this.#manifest.chunkCount; index += 1) {
      const current = this.#chunks.get(index);
      if (current === undefined) return this.#abort("invalid_chunk");
      complete.set(current, offset);
      offset += current.byteLength;
    }
    try {
      if (await this.#digest.sha256Base64URL(complete) !== this.#manifest.sha256) return this.#abort("integrity_failed");
    } catch { return this.#abort("digest_failed"); }
    this.#phase = "completed";
    this.#clearChunks();
    return { status: "completed", bytes: complete, manifest: copyManifest(this.#manifest) };
  }

  expire(now: number): ImageTransferReassemblyResult | undefined {
    return this.#expire(now) ? { status: "expired", reason: "expired" } : undefined;
  }

  #expire(now: number): boolean {
    if (!Number.isSafeInteger(now) || now >= this.#manifest.expiresAt) {
      if (!this.terminal) {
        this.#phase = "expired";
        this.#clearChunks();
      }
      return true;
    }
    return this.#phase === "expired";
  }

  #abort(reason: Exclude<ImageTransferReassemblyFailure, "expired" | "no_transfer">): ImageTransferReassemblyResult {
    if (!this.terminal) {
      this.#phase = "aborted";
      this.#clearChunks();
    }
    return { status: "aborted", reason };
  }

  #clearChunks(): void {
    this.#chunks.clear();
    this.#receivedBytes = 0;
  }
}

/**
 * Endpoint-owned bounded registry. A relay never owns this object, and it has
 * no persistence or scheduling: adapters call `expire` with their own clock.
 */
export class ImageTransferReassemblyRegistry {
  readonly #digest: ImageTransferDigestPort;
  readonly #options: ImageTransferReassemblyOptions;
  readonly #active = new Map<string, ImageTransferReassembly>();
  readonly #closed = new Map<string, number>();

  constructor(digest: ImageTransferDigestPort, options: ImageTransferReassemblyOptions = {}) {
    validateOptions(options);
    this.#digest = digest;
    this.#options = options;
  }

  open(peerId: string, manifest: ImageTransferManifest, now: number): ImageTransferReassemblyResult {
    this.#sweep(now);
    try {
      validateImageTransferManifest(manifest);
      if (!validPeerId(peerId)) throw new Error("invalid image transfer peer");
    } catch { return { status: "ignored", reason: "invalid_manifest" }; }
    const key = transferKey(peerId, manifest);
    if (this.#closed.has(key)) return { status: "replayed", reason: "no_transfer" };
    const existing = this.#active.get(peerId);
    if (existing !== undefined) return existing.matchesManifest(manifest) ? { status: "duplicate_manifest" } : { status: "busy", reason: "no_transfer" };
    const maximumActiveTransfers = this.#options.maximumActiveTransfers ?? 16;
    if (this.#active.size >= maximumActiveTransfers) return { status: "busy", reason: "no_transfer" };
    try {
      this.#active.set(peerId, ImageTransferReassembly.open(peerId, manifest, this.#digest, this.#options, now));
      return { status: "opened" };
    } catch { return { status: "ignored", reason: "expired" }; }
  }

  async receiveChunk(peerId: string, chunk: ImageTransferChunk, now: number): Promise<ImageTransferReassemblyResult> {
    this.#sweep(now);
    const transfer = this.#active.get(peerId);
    if (transfer === undefined) return { status: "ignored", reason: "no_transfer" };
    const result = await transfer.receiveChunk(chunk, now);
    this.#sweep(now);
    return result;
  }

  expire(now: number): void { this.#sweep(now); }

  clear(): void {
    this.#active.clear();
    this.#closed.clear();
  }

  #sweep(now: number): void {
    if (!Number.isSafeInteger(now)) throw new Error("invalid image transfer time");
    for (const [key, expiresAt] of this.#closed) if (now >= expiresAt) this.#closed.delete(key);
    for (const [peerId, transfer] of this.#active) {
      transfer.expire(now);
      if (transfer.terminal) {
        this.#active.delete(peerId);
        this.#closed.set(transfer.key, transfer.expiresAt);
      }
    }
    const maximumRememberedTransfers = this.#options.maximumRememberedTransfers ?? 16;
    while (this.#closed.size > maximumRememberedTransfers) {
      const oldest = this.#closed.keys().next().value;
      if (oldest === undefined) break;
      this.#closed.delete(oldest);
    }
  }
}

function validateOptions(options: ImageTransferReassemblyOptions): void {
  const maximumTransferBytes = options.maximumTransferBytes ?? maxImageDirectBytes;
  const maximumReorderChunks = options.maximumReorderChunks ?? 64;
  const maximumActiveTransfers = options.maximumActiveTransfers ?? 16;
  const maximumRememberedTransfers = options.maximumRememberedTransfers ?? 16;
  if (!Number.isSafeInteger(maximumTransferBytes) || maximumTransferBytes < 1 || maximumTransferBytes > maxImageDirectBytes
    || !Number.isSafeInteger(maximumReorderChunks) || maximumReorderChunks < 0 || maximumReorderChunks >= maxImageTransferChunks
    || !Number.isSafeInteger(maximumActiveTransfers) || maximumActiveTransfers < 1 || maximumActiveTransfers > 16
    || !Number.isSafeInteger(maximumRememberedTransfers) || maximumRememberedTransfers < 1 || maximumRememberedTransfers > 64) throw new Error("invalid image transfer reassembly options");
}

function validPeerId(value: string): boolean { return value.length > 0 && value.length <= 128; }
function transferKey(peerId: string, manifest: ImageTransferManifest): string { return `${peerId}:${manifest.transferId}:${manifest.manifestId}`; }
function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}
function copyManifest(manifest: ImageTransferManifest): ImageTransferManifest { return { ...manifest, signature: new Uint8Array(manifest.signature) }; }
