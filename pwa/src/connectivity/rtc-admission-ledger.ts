import { encodeBase64URL } from "@code4bones/branch-core";

export const maxRTCAdmissionEntries = 32;

export type RTCAdmissionReservation =
  | { readonly kind: "first" }
  | { readonly kind: "duplicate_admitted" }
  | { readonly kind: "duplicate_pending" }
  | { readonly kind: "conflict" };

interface AdmissionEntry {
  readonly ciphertextSHA256: string;
  readonly expiresAt: number;
  admitted: boolean;
}

// A volatile, cross-path ingress boundary. It deliberately owns only opaque
// ciphertext fingerprints: application projection has its own durable message
// deduplication and relay attachment state never enters this ledger.
export class RTCAdmissionLedger {
  readonly #entries = new Map<string, AdmissionEntry>();

  constructor(private readonly maximumEntries: number = maxRTCAdmissionEntries) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1 || maximumEntries > maxRTCAdmissionEntries) {
      throw new Error("invalid rtc admission ledger capacity");
    }
  }

  async reserve(input: {
    readonly senderPeerId: string;
    readonly streamId: number;
    readonly deliveryId: string;
    readonly ciphertext: Uint8Array;
    readonly expiresAt: number;
    readonly now: number;
  }): Promise<RTCAdmissionReservation> {
    if (!Number.isSafeInteger(input.streamId) || input.streamId < 0 || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= input.now || input.ciphertext.byteLength === 0) {
      throw new Error("invalid rtc admission reservation");
    }
    this.prune(input.now);
    const key = admissionKey(input.senderPeerId, input.streamId, input.deliveryId);
    const fingerprint = await ciphertextSHA256(input.ciphertext);
    const existing = this.#entries.get(key);
    if (existing !== undefined) {
      if (existing.ciphertextSHA256 !== fingerprint) return { kind: "conflict" };
      return { kind: existing.admitted ? "duplicate_admitted" : "duplicate_pending" };
    }
    while (this.#entries.size >= this.maximumEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    this.#entries.set(key, { ciphertextSHA256: fingerprint, expiresAt: input.expiresAt, admitted: false });
    return { kind: "first" };
  }

  admit(senderPeerId: string, streamId: number, deliveryId: string, now: number): boolean {
    this.prune(now);
    const entry = this.#entries.get(admissionKey(senderPeerId, streamId, deliveryId));
    if (entry === undefined || entry.expiresAt <= now) return false;
    entry.admitted = true;
    return true;
  }

  reset(): void {
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.#entries) if (entry.expiresAt <= now) this.#entries.delete(key);
  }
}

function admissionKey(senderPeerId: string, streamId: number, deliveryId: string): string {
  if (senderPeerId.length === 0 || deliveryId.length === 0) throw new Error("invalid rtc admission key");
  return `${senderPeerId}\u0000${String(streamId)}\u0000${deliveryId}`;
}

async function ciphertextSHA256(ciphertext: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(ciphertext).buffer);
  return encodeBase64URL(new Uint8Array(digest));
}
