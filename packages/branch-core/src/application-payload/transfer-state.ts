import {
  attachmentDecisionSigningBytes,
  attachmentManifestSigningBytes,
  maxAttachmentChunks,
  maxDirectAttachmentBytes,
  type AttachmentChunk,
  type AttachmentDecision,
  type AttachmentManifest,
  validateChunkForManifest
} from "./attachment.js";

/** The application-owned port used to verify a completed file. */
export interface AttachmentDigestPort {
  sha256Base64URL(bytes: Uint8Array): Promise<string>;
}

export type AttachmentTransferDirection = "inbound" | "outbound";
export type AttachmentTransferPhase =
  | "offered"
  | "accepted"
  | "completed"
  | "rejected"
  | "cancelled"
  | "expired"
  | "aborted";

export type AttachmentTransferResult =
  | { readonly status: "accepted" | "duplicate" | "chunk_stored"; readonly phase: AttachmentTransferPhase }
  | { readonly status: "completed"; readonly phase: "completed"; readonly bytes: Uint8Array }
  | { readonly status: "rejected" | "cancelled" | "expired" | "aborted"; readonly phase: AttachmentTransferPhase; readonly reason: AttachmentTransferFailure }
  | { readonly status: "ignored"; readonly phase: AttachmentTransferPhase; readonly reason: AttachmentTransferFailure };

export type AttachmentTransferFailure =
  | "not_accepted"
  | "expired"
  | "rejected"
  | "cancelled"
  | "wrong_direction"
  | "wrong_transfer"
  | "invalid_decision"
  | "invalid_chunk"
  | "reorder_limit"
  | "conflicting_duplicate"
  | "integrity_failed"
  | "digest_failed";

export interface AttachmentTransferSnapshot {
  readonly direction: AttachmentTransferDirection;
  readonly phase: AttachmentTransferPhase;
  readonly transferId: string;
  readonly manifestId: string;
  readonly receivedChunks: number;
  readonly receivedBytes: number;
  readonly nextMissingIndex: number;
}

export interface AttachmentTransferOptions {
  /** A caller selects this from its current direct/relay admission policy. */
  readonly maximumTransferBytes?: number;
  /** Maximum forward distance of a received chunk from the first missing index. */
  readonly maximumReorderChunks?: number;
}

export interface AttachmentTransferRegistryOptions extends AttachmentTransferOptions {
  /** Bounded local replay memory; it is never relay state or durable storage. */
  readonly maximumRememberedTransfers?: number;
}

export type AttachmentTransferOpenResult =
  | { readonly status: "opened" | "duplicate"; readonly transfer: AttachmentTransferState }
  | { readonly status: "busy" | "replayed" | "aborted" };

const terminalPhases: ReadonlySet<AttachmentTransferPhase> = new Set([
  "completed", "rejected", "cancelled", "expired", "aborted"
]);

// This is deliberately a per-peer-direction object. An adapter owns one such
// object for a live peer direction, so it cannot accidentally start a second
// transfer while the first one remains actionable.
export class AttachmentTransferState {
  readonly #direction: AttachmentTransferDirection;
  readonly #manifest: AttachmentManifest;
  readonly #digest: AttachmentDigestPort;
  readonly #maximumReorderChunks: number;
  readonly #chunks = new Map<number, Uint8Array>();
  #phase: AttachmentTransferPhase = "offered";
  #receivedBytes = 0;
  #nextMissingIndex = 0;

  private constructor(
    direction: AttachmentTransferDirection,
    manifest: AttachmentManifest,
    digest: AttachmentDigestPort,
    maximumReorderChunks: number
  ) {
    this.#direction = direction;
    this.#manifest = copyManifest(manifest);
    this.#digest = digest;
    this.#maximumReorderChunks = maximumReorderChunks;
  }

  static open(
    direction: AttachmentTransferDirection,
    manifest: AttachmentManifest,
    digest: AttachmentDigestPort,
    options: AttachmentTransferOptions = {},
    now: number
  ): AttachmentTransferState {
    attachmentManifestSigningBytes(manifest);
    validateOpenOptions(options);
    if (!Number.isSafeInteger(now) || now >= manifest.expiresAt) throw new Error("attachment transfer is expired");
    const maximumTransferBytes = options.maximumTransferBytes ?? maxDirectAttachmentBytes;
    if (manifest.byteCount > maximumTransferBytes) throw new Error("attachment transfer exceeds local limit");
    return new AttachmentTransferState(direction, manifest, digest, options.maximumReorderChunks ?? 64);
  }

  get manifest(): AttachmentManifest { return copyManifest(this.#manifest); }
  get phase(): AttachmentTransferPhase { return this.#phase; }
  get terminal(): boolean { return terminalPhases.has(this.#phase); }

  snapshot(): AttachmentTransferSnapshot {
    return {
      direction: this.#direction,
      phase: this.#phase,
      transferId: this.#manifest.transferId,
      manifestId: this.#manifest.manifestId,
      receivedChunks: this.#chunks.size,
      receivedBytes: this.#receivedBytes,
      nextMissingIndex: this.#nextMissingIndex
    };
  }

  // The caller authenticates the signature before calling this core. This core
  // still validates canonical decision shape, binding, TTL, and transition.
  accept(decision: AttachmentDecision, now: number): AttachmentTransferResult {
    if (this.#direction !== "inbound") return this.#ignore("wrong_direction");
    if (this.#expire(now)) return this.#terminal("expired");
    if (!this.#matchesDecision(decision, "accept", now)) return this.#abort("invalid_decision");
    if (this.#phase === "accepted") return this.#ok("duplicate");
    if (this.#phase !== "offered") return this.#conflict();
    this.#phase = "accepted";
    return this.#ok("accepted");
  }

  receiveDecision(decision: AttachmentDecision, now: number): AttachmentTransferResult {
    if (this.#direction !== "outbound") return this.#ignore("wrong_direction");
    if (this.#expire(now)) return this.#terminal("expired");
    if (!this.#matchesDecision(decision, undefined, now)) return this.#abort("invalid_decision");
    if (decision.kind === "cancel") return this.#cancel();
    if (this.#phase === "offered" && decision.kind === "accept") {
      this.#phase = "accepted";
      return this.#ok("accepted");
    }
    if (this.#phase === "offered" && decision.kind === "reject") {
      this.#phase = "rejected";
      return this.#terminal("rejected");
    }
    if (this.#phase === "accepted" && decision.kind === "accept") return this.#ok("duplicate");
    return this.#conflict();
  }

  cancel(decision: AttachmentDecision, now: number): AttachmentTransferResult {
    if (this.#expire(now)) return this.#terminal("expired");
    if (!this.#matchesDecision(decision, "cancel", now)) return this.#abort("invalid_decision");
    return this.#cancel();
  }

  // A sender can use this to refuse chunks before receiver acceptance. It does
  // not retain outbound bytes or implement retransmission.
  admitOutboundChunk(chunk: AttachmentChunk, now: number): AttachmentTransferResult {
    if (this.#direction !== "outbound") return this.#ignore("wrong_direction");
    if (this.#expire(now)) return this.#terminal("expired");
    if (this.#phase !== "accepted") return this.#ignore("not_accepted");
    try { validateChunkForManifest(chunk, this.#manifest); } catch { return this.#abort("invalid_chunk"); }
    return this.#ok("chunk_stored");
  }

  async receiveChunk(chunk: AttachmentChunk, now: number): Promise<AttachmentTransferResult> {
    if (this.#direction !== "inbound") return this.#ignore("wrong_direction");
    if (this.#expire(now)) return this.#terminal("expired");
    if (this.#phase !== "accepted") return this.#ignore("not_accepted");
    try { validateChunkForManifest(chunk, this.#manifest); } catch { return this.#abort("invalid_chunk"); }

    const existing = this.#chunks.get(chunk.index);
    if (existing !== undefined) {
      if (bytesEqual(existing, chunk.bytes)) return this.#ok("duplicate");
      return this.#abort("conflicting_duplicate");
    }
    if (chunk.index - this.#nextMissingIndex > this.#maximumReorderChunks) return this.#abort("reorder_limit");

    const copy = new Uint8Array(chunk.bytes.byteLength);
    copy.set(chunk.bytes);
    this.#chunks.set(chunk.index, copy);
    this.#receivedBytes += copy.byteLength;
    while (this.#chunks.has(this.#nextMissingIndex)) this.#nextMissingIndex += 1;
    if (this.#chunks.size !== this.#manifest.chunkCount) return this.#ok("chunk_stored");
    if (this.#receivedBytes !== this.#manifest.byteCount) return this.#abort("invalid_chunk");

    const file = new Uint8Array(this.#manifest.byteCount);
    let offset = 0;
    for (let index = 0; index < this.#manifest.chunkCount; index += 1) {
      const bytes = this.#chunks.get(index);
      if (bytes === undefined) return this.#abort("invalid_chunk");
      file.set(bytes, offset);
      offset += bytes.byteLength;
    }
    try {
      if (await this.#digest.sha256Base64URL(file) !== this.#manifest.sha256) return this.#abort("integrity_failed");
    } catch {
      return this.#abort("digest_failed");
    }
    this.#phase = "completed";
    this.#clearChunks();
    return { status: "completed", phase: "completed", bytes: file };
  }

  expire(now: number): AttachmentTransferResult {
    if (this.#expire(now)) return this.#terminal("expired");
    return this.#ok("duplicate");
  }

  /** Ends this local live transfer after a detected conflicting offer. */
  abort(): AttachmentTransferResult { return this.#abort("conflicting_duplicate"); }

  #matchesDecision(decision: AttachmentDecision, requiredKind: AttachmentDecision["kind"] | undefined, now: number): boolean {
    try { attachmentDecisionSigningBytes(decision); } catch { return false; }
    return decision.transferId === this.#manifest.transferId
      && decision.manifestId === this.#manifest.manifestId
      && (requiredKind === undefined || decision.kind === requiredKind)
      && Number.isSafeInteger(now)
      && now < decision.expiresAt
      && now < this.#manifest.expiresAt;
  }

  #expire(now: number): boolean {
    if (!Number.isSafeInteger(now)) return true;
    if (!this.terminal && now >= this.#manifest.expiresAt) {
      this.#phase = "expired";
      this.#clearChunks();
      return true;
    }
    return this.#phase === "expired";
  }

  #cancel(): AttachmentTransferResult {
    if (this.#phase === "cancelled") return this.#ok("duplicate");
    if (this.terminal) return this.#conflict();
    this.#phase = "cancelled";
    this.#clearChunks();
    return this.#terminal("cancelled");
  }

  #conflict(): AttachmentTransferResult { return this.#abort("conflicting_duplicate"); }
  #abort(reason: AttachmentTransferFailure): AttachmentTransferResult {
    if (!this.terminal) {
      this.#phase = "aborted";
      this.#clearChunks();
    }
    return this.#terminal(reason);
  }
  #clearChunks(): void { this.#chunks.clear(); this.#receivedBytes = 0; }
  #ok(status: "accepted" | "duplicate" | "chunk_stored"): AttachmentTransferResult { return { status, phase: this.#phase }; }
  #terminal(reason: AttachmentTransferFailure): AttachmentTransferResult {
    const status = this.#phase === "rejected" ? "rejected" : this.#phase === "cancelled" ? "cancelled" : this.#phase === "expired" ? "expired" : "aborted";
    return { status, phase: this.#phase, reason };
  }
  #ignore(reason: AttachmentTransferFailure): AttachmentTransferResult { return { status: "ignored", phase: this.#phase, reason }; }
}

// One registry is owned by one peer and one direction. It provides the
// admission boundary which makes concurrent offers impossible while retaining
// only a small, expiring local replay memory after a transfer reaches terminal
// state. It has no clock, network, storage, or relay dependency.
export class AttachmentTransferRegistry {
  readonly #direction: AttachmentTransferDirection;
  readonly #digest: AttachmentDigestPort;
  readonly #options: AttachmentTransferRegistryOptions;
  readonly #closed = new Map<string, number>();
  #active: AttachmentTransferState | undefined;

  constructor(direction: AttachmentTransferDirection, digest: AttachmentDigestPort, options: AttachmentTransferRegistryOptions = {}) {
    validateOpenOptions(options);
    const maximumRememberedTransfers = options.maximumRememberedTransfers ?? 16;
    if (!Number.isSafeInteger(maximumRememberedTransfers) || maximumRememberedTransfers < 1 || maximumRememberedTransfers > 64) throw new Error("invalid attachment transfer registry options");
    this.#direction = direction;
    this.#digest = digest;
    this.#options = options;
  }

  get active(): AttachmentTransferState | undefined { return this.#active; }

  open(manifest: AttachmentManifest, now: number): AttachmentTransferOpenResult {
    this.#sweep(now);
    const key = transferKey(manifest);
    if (this.#closed.has(key)) return { status: "replayed" };
    if (this.#active !== undefined) {
      if (transferKey(this.#active.manifest) !== key) return { status: "busy" };
      if (bytesEqual(attachmentManifestSigningBytes(this.#active.manifest), attachmentManifestSigningBytes(manifest))) return { status: "duplicate", transfer: this.#active };
      this.#active.abort();
      this.#sweep(now);
      return { status: "aborted" };
    }
    const transfer = AttachmentTransferState.open(this.#direction, manifest, this.#digest, this.#options, now);
    this.#active = transfer;
    return { status: "opened", transfer };
  }

  expire(now: number): void { this.#active?.expire(now); this.#sweep(now); }

  #sweep(now: number): void {
    if (!Number.isSafeInteger(now)) throw new Error("invalid attachment transfer time");
    for (const [key, expiresAt] of this.#closed) if (now >= expiresAt) this.#closed.delete(key);
    if (this.#active?.terminal) {
      this.#closed.set(transferKey(this.#active.manifest), this.#active.manifest.expiresAt);
      this.#active = undefined;
    }
    const maximumRememberedTransfers = this.#options.maximumRememberedTransfers ?? 16;
    while (this.#closed.size > maximumRememberedTransfers) {
      const oldest = this.#closed.keys().next().value;
      if (oldest === undefined) break;
      this.#closed.delete(oldest);
    }
  }
}

function validateOpenOptions(options: AttachmentTransferOptions): void {
  const maximumTransferBytes = options.maximumTransferBytes ?? maxDirectAttachmentBytes;
  const maximumReorderChunks = options.maximumReorderChunks ?? 64;
  if (!Number.isSafeInteger(maximumTransferBytes) || maximumTransferBytes < 1 || maximumTransferBytes > maxDirectAttachmentBytes || !Number.isSafeInteger(maximumReorderChunks) || maximumReorderChunks < 0 || maximumReorderChunks >= maxAttachmentChunks) throw new Error("invalid attachment transfer options");
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

function transferKey(manifest: AttachmentManifest): string { return `${manifest.transferId}:${manifest.manifestId}`; }

function copyManifest(manifest: AttachmentManifest): AttachmentManifest {
  return { ...manifest, signature: new Uint8Array(manifest.signature) };
}
