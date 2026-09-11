import {
  applicationControlSigningBytes,
  createApplicationControlRegistry,
  decodeApplicationControl,
  decodeImageCapabilities,
  encodeApplicationControl,
  encodeBase64URL,
  encodeImageCapabilities,
  imageCapabilitiesControlKind,
  imageMessageVersion,
  maxImageDirectBytes,
  maxImagePixels,
  maxImageRelayBytes,
  maxImageWidth,
  maxImageHeight,
  prepareOutboundApplicationControl,
  processApplicationControl,
  type ApplicationControlDescriptor,
  type ApplicationControlRejection,
  type ImageCapabilities
} from "@code4bones/branch-core";

/** The five-minute maximum is part of the signed application-control contract. */
export const imageCapabilitiesControlTTLms = 5 * 60_000;
const capabilityReplyCooldownMs = 1_000;

const maximumPeers = 64;
const maximumReplayControls = 128;

export type ImageCapabilitiesOutcome = "accepted" | ApplicationControlRejection;

export interface ImageCapabilitiesSendRequest {
  readonly peerId: string;
  /** Exact signed application-control bytes for the existing HPKE adapter. */
  readonly plaintext: Uint8Array;
}

export interface ImageCapabilitiesControlPorts {
  readonly now: () => number;
  readonly randomBytes: (bytes: Uint8Array) => Uint8Array;
  readonly localPeerId: () => string;
  readonly localSigningKey: () => CryptoKey | null;
  readonly isKnownPeer: (peerId: string) => boolean;
  readonly knownPeerSigningKey: (peerId: string) => CryptoKey | null | Promise<CryptoKey | null>;
  readonly send: (request: ImageCapabilitiesSendRequest) => void | Promise<void>;
  /** Receiver-owned limits. Returning null disables automatic admission. */
  readonly localCapabilities: () => ImageCapabilities | null;
}

export interface ReceivedImageCapabilities {
  readonly handled: boolean;
  readonly outcome?: ImageCapabilitiesOutcome;
  readonly capabilities?: ImageCapabilities;
  readonly expiresAt?: number;
}

export const imageCapabilitiesControlDescriptor: ApplicationControlDescriptor<ImageCapabilities> = {
  kind: imageCapabilitiesControlKind,
  authentication: "ed25519",
  maximumTTLms: imageCapabilitiesControlTTLms,
  projection: "ephemeral",
  allowedEffects: ["ephemeral_projection"],
  decodeBody: decodeImageCapabilities,
  encodeBody: encodeImageCapabilities,
  reduce: ({ envelope, body }) => [{
    kind: "ephemeral_projection",
    projection: "image_capabilities",
    value: encodeImageCapabilities(body),
    expiresAt: envelope.expiresAt
  }]
};

const registry = createApplicationControlRegistry([imageCapabilitiesControlDescriptor]);

/**
 * Volatile, per-tab image capability exchange. It intentionally contains no
 * relay authority, durable state, image bytes, retry queue, or UI dependency.
 */
export class ImageCapabilitiesController {
  readonly #ports: ImageCapabilitiesControlPorts;
  readonly #received = new Map<string, { readonly capabilities: ImageCapabilities; readonly expiresAt: number }>();
  readonly #advertised = new Map<string, { readonly capabilities: ImageCapabilities; readonly expiresAt: number }>();
  readonly #seenControls = new Map<string, number>();
  readonly #lastReplyAt = new Map<string, number>();

  constructor(ports: ImageCapabilitiesControlPorts) {
    this.#ports = ports;
  }

  /** Signs and sends one live receiver-consent advertisement; it never retries. */
  async advertise(peerId: string): Promise<"sent" | "skipped"> {
    const now = this.#ports.now();
    this.#prune(now);
    const capabilities = this.#ports.localCapabilities();
    const localPeerId = this.#ports.localPeerId();
    const signingKey = this.#ports.localSigningKey();
    if (capabilities === null || signingKey === null || localPeerId === "" || !this.#ports.isKnownPeer(peerId)) return "skipped";
    try {
      const expiresAt = now + imageCapabilitiesControlTTLms;
      const unsigned = prepareOutboundApplicationControl({
        kind: imageCapabilitiesControlKind,
        controlId: this.#token(16),
        issuedAt: now,
        expiresAt,
        senderPeerId: localPeerId,
        recipientPeerId: peerId,
        body: capabilities
      }, imageCapabilitiesControlDescriptor, {
        now,
        localPeerId,
        isKnownContact: (candidate) => candidate === peerId && this.#ports.isKnownPeer(candidate),
        isAllowed: () => true,
        consumeRateLimit: () => true,
        maxClockSkewMs: 1_000
      });
      const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", signingKey, buffer(applicationControlSigningBytes(unsigned))));
      await this.#ports.send({ peerId, plaintext: encodeApplicationControl({ ...unsigned, signature }) });
      this.#remember(this.#advertised, peerId, { capabilities: copyCapabilities(capabilities), expiresAt });
      return "sent";
    } catch {
      return "skipped";
    }
  }

  /** Processes exactly the image capability control; other controls are left to their owner. */
  async receive(peerId: string, plaintext: Uint8Array): Promise<ReceivedImageCapabilities> {
    let envelope: ReturnType<typeof decodeApplicationControl>;
    try { envelope = decodeApplicationControl(plaintext); } catch { return { handled: false }; }
    if (envelope.kind !== imageCapabilitiesControlKind) return { handled: false };
    const now = this.#ports.now();
    this.#prune(now);
    const result = await processApplicationControl(plaintext, registry, {
      now,
      localPeerId: this.#ports.localPeerId(),
      isKnownContact: (candidate) => candidate === peerId && this.#ports.isKnownPeer(candidate),
      verifyEd25519: async (candidate, input, signature) => await this.#verify(candidate, input, signature),
      hasSeenControl: (controlId) => this.#seenControls.has(controlId),
      rememberControl: (controlId, expiresAt) => {
        this.#trim(this.#seenControls);
        this.#seenControls.set(controlId, expiresAt);
      },
      isAllowed: () => true,
      maxClockSkewMs: 1_000
    });
    if (result.status !== "accepted") return { handled: true, outcome: result.reason };
    const effect = result.effects.find((candidate) => candidate.kind === "ephemeral_projection" && candidate.projection === "image_capabilities");
    if (effect?.kind !== "ephemeral_projection") return { handled: true, outcome: "effect_forbidden" };
    try {
      const capabilities = decodeImageCapabilities(effect.value);
      this.#remember(this.#received, peerId, { capabilities: copyCapabilities(capabilities), expiresAt: effect.expiresAt });
      return { handled: true, outcome: "accepted", capabilities: copyCapabilities(capabilities), expiresAt: effect.expiresAt };
    } catch {
      return { handled: true, outcome: "body_invalid" };
    }
  }

  /** Current remote consent for outbound images, copied out of volatile memory. */
  peerCapabilities(peerId: string): ImageCapabilities | null {
    this.#prune(this.#ports.now());
    const entry = this.#received.get(peerId);
    return entry === undefined ? null : copyCapabilities(entry.capabilities);
  }

  /**
   * Current local consent actually sent to this peer. Wire an inbound image
   * controller to this method: a configured local limit alone is insufficient.
   */
  inboundCapabilities(peerId: string): ImageCapabilities | null {
    this.#prune(this.#ports.now());
    const entry = this.#advertised.get(peerId);
    return entry === undefined ? null : copyCapabilities(entry.capabilities);
  }

  /** True only after this tab has actually sent current receiver consent. */
  hasAdvertised(peerId: string): boolean {
    this.#prune(this.#ports.now());
    return this.#advertised.has(peerId);
  }

  /**
   * A renewed remote advertisement asks for our current consent again after
   * its volatile cache has been lost. Answer it even when we advertised in a
   * previous session, but suppress the reciprocal reply loop for one second.
   */
  shouldReplyTo(peerId: string): boolean {
    const now = this.#ports.now();
    this.#prune(now);
    if (!this.#ports.isKnownPeer(peerId)) return false;
    const previous = this.#lastReplyAt.get(peerId);
    if (previous !== undefined && now - previous < capabilityReplyCooldownMs) return false;
    this.#remember(this.#lastReplyAt, peerId, now);
    return true;
  }

  clear(): void {
    this.#received.clear();
    this.#advertised.clear();
    this.#seenControls.clear();
    this.#lastReplyAt.clear();
  }

  #token(size: number): string {
    return encodeBase64URL(this.#ports.randomBytes(new Uint8Array(size)));
  }

  async #verify(peerId: string, input: Uint8Array, signature: Uint8Array): Promise<boolean> {
    try {
      const key = await this.#ports.knownPeerSigningKey(peerId);
      return key !== null && await crypto.subtle.verify("Ed25519", key, buffer(signature), buffer(input));
    } catch { return false; }
  }

  #remember<T>(map: Map<string, T>, peerId: string, value: T): void {
    this.#trim(map);
    map.set(peerId, value);
  }

  #trim<T>(map: Map<string, T>): void {
    while (map.size >= maximumPeers) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) return;
      map.delete(oldest);
    }
  }

  #prune(now: number): void {
    for (const [peerId, entry] of this.#received) if (entry.expiresAt <= now) this.#received.delete(peerId);
    for (const [peerId, entry] of this.#advertised) if (entry.expiresAt <= now) this.#advertised.delete(peerId);
    for (const [controlId, expiresAt] of this.#seenControls) if (expiresAt <= now) this.#seenControls.delete(controlId);
    for (const [peerId, repliedAt] of this.#lastReplyAt) if (now - repliedAt >= capabilityReplyCooldownMs) this.#lastReplyAt.delete(peerId);
    while (this.#seenControls.size > maximumReplayControls) this.#seenControls.delete(this.#seenControls.keys().next().value as string);
  }
}

/** Conservative receiver defaults. A product integration may advertise less. */
export function defaultImageCapabilities(): ImageCapabilities {
  return {
    version: imageMessageVersion,
    maxInlineBytes: 2_800,
    maxRelayBytes: maxImageRelayBytes,
    maxDirectBytes: maxImageDirectBytes,
    maxWidth: maxImageWidth,
    maxHeight: maxImageHeight,
    maxPixels: maxImagePixels
  };
}

function copyCapabilities(value: ImageCapabilities): ImageCapabilities {
  return { ...value };
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}
