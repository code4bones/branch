import { Aes128Gcm, CipherSuite, HkdfSha256 } from "@hpke/core";
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519";

import { decodeBase64URL, encodeBase64URL } from "../protocol/v0/base64url.js";

export const betaHpkePayloadSuiteID = "branch.hpke/0.draft" as const;
export const betaHpkeCiphersuite = "DHKEM(X25519,HKDF-SHA256)+HKDF-SHA256+AES-128-GCM" as const;
export const betaHpkeAADVersion = "branch.hpke.aad/1.draft" as const;

export interface BetaPayloadKeyPair {
  readonly publicKey: string;
  readonly privateKey: CryptoKey;
}

export interface BetaPayloadKeyExport {
  readonly publicKey: string;
  readonly privateKey: string;
}

export interface SealBetaPayloadOptions {
  readonly recipientPublicKey: string;
  readonly plaintext: string | Uint8Array;
  readonly aad: string | Uint8Array;
  readonly expectedCiphertextBytes: number;
}

export interface OpenBetaPayloadOptions {
  readonly recipientPrivateKey: CryptoKey;
  readonly sealedPayload: string;
  readonly aad: string | Uint8Array;
  readonly expectedCiphertextBytes: number;
}

interface EncodedSealedPayload {
  readonly suite_id: typeof betaHpkePayloadSuiteID;
  readonly ciphersuite: typeof betaHpkeCiphersuite;
  readonly enc: string;
  readonly ct: string;
}

const maxPlaintextBytes = 4_096;
const maxAADBytes = 2_048;
const maxSealedPayloadBytes = 8_192;
const hpkeAuthenticationTagBytes = 16;
const suite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes128Gcm()
});
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export async function createBetaPayloadKeyPair(): Promise<BetaPayloadKeyPair> {
  const keyPair = await suite.kem.generateKeyPair();
  const publicKey = await suite.kem.serializePublicKey(keyPair.publicKey);
  return {
    publicKey: encodeBase64URL(new Uint8Array(publicKey)),
    privateKey: keyPair.privateKey
  };
}

export async function exportBetaPayloadKeyPair(keyPair: BetaPayloadKeyPair): Promise<BetaPayloadKeyExport> {
  const privateKey = await suite.kem.serializePrivateKey(keyPair.privateKey);
  return {
    publicKey: keyPair.publicKey,
    privateKey: encodeBase64URL(new Uint8Array(privateKey))
  };
}

export async function importBetaPayloadKeyPair(keyPair: BetaPayloadKeyExport): Promise<BetaPayloadKeyPair> {
  return {
    publicKey: keyPair.publicKey,
    privateKey: await suite.kem.deserializePrivateKey(decodeBase64URL(keyPair.privateKey))
  };
}

export async function sealBetaPayload(options: SealBetaPayloadOptions): Promise<string> {
  const plaintext = boundedBytes(options.plaintext, maxPlaintextBytes, "payload plaintext");
  const aad = boundedBytes(options.aad, maxAADBytes, "payload aad");
  const expectedCiphertextBytes = boundedCiphertextBytes(options.expectedCiphertextBytes);
  const recipientPublicKey = await suite.kem.deserializePublicKey(decodeBase64URL(options.recipientPublicKey));
  const sealed = await suite.seal({
    recipientPublicKey,
    info: textEncoder.encode(betaHpkePayloadSuiteID)
  }, plaintext, aad);
  const payload: EncodedSealedPayload = {
    suite_id: betaHpkePayloadSuiteID,
    ciphersuite: betaHpkeCiphersuite,
    enc: encodeBase64URL(new Uint8Array(sealed.enc)),
    ct: encodeBase64URL(new Uint8Array(sealed.ct))
  };
  if (decodeBase64URL(payload.ct).byteLength !== expectedCiphertextBytes) {
    throw new Error("unexpected HPKE ciphertext length");
  }
  const encoded = encodeBase64URL(textEncoder.encode(JSON.stringify(payload)));
  if (encoded.length > maxSealedPayloadBytes) {
    throw new Error("sealed payload too large");
  }
  return encoded;
}

export async function openBetaPayload(options: OpenBetaPayloadOptions): Promise<Uint8Array> {
  const aad = boundedBytes(options.aad, maxAADBytes, "payload aad");
  const payload = decodeSealedPayload(options.sealedPayload);
  const ciphertext = decodeBase64URL(payload.ct);
  if (ciphertext.byteLength !== boundedCiphertextBytes(options.expectedCiphertextBytes)) {
    throw new Error("unexpected HPKE ciphertext length");
  }
  const plaintext = await suite.open({
    recipientKey: options.recipientPrivateKey,
    enc: decodeBase64URL(payload.enc),
    info: textEncoder.encode(betaHpkePayloadSuiteID)
  }, ciphertext, aad);
  return new Uint8Array(plaintext);
}

export function betaHpkeCiphertextBytesForPlaintext(plaintext: string | Uint8Array): number {
  return boundedBytes(plaintext, maxPlaintextBytes, "payload plaintext").byteLength + hpkeAuthenticationTagBytes;
}

export function betaHpkeCiphertextBytesFromSealedPayload(sealedPayload: string): number {
  return boundedCiphertextBytes(decodeBase64URL(decodeSealedPayload(sealedPayload).ct).byteLength);
}

export function makeBetaPayloadAAD(fields: {
  readonly protocol: string;
  readonly profileMultihash: string;
  readonly originRouteId: string;
  readonly senderPeerKey: string;
  readonly recipientPeerKey: string;
  readonly deliveryId: string;
  readonly pathEpoch: number;
  readonly streamId: number;
  readonly frameType: "ENVELOPE";
  readonly ackRequested: boolean;
  readonly hpkeCiphertextBytes: number;
}): Uint8Array {
  requireBase64URLBytes(fields.originRouteId, 16, "origin route id");
  requireBase64URLBytes(fields.senderPeerKey, 32, "sender peer key");
  requireBase64URLBytes(fields.recipientPeerKey, 32, "recipient peer key");
  requireBase64URLBytes(fields.deliveryId, 16, "delivery id");
  if (!Number.isSafeInteger(fields.pathEpoch) || fields.pathEpoch < 0 || !Number.isSafeInteger(fields.streamId) || fields.streamId < 0) {
    throw new Error("invalid payload sequence");
  }
  return textEncoder.encode(JSON.stringify({
    aad_version: betaHpkeAADVersion,
    protocol: fields.protocol,
    profile_multihash: fields.profileMultihash,
    origin_route_id: fields.originRouteId,
    sender_peer_key: fields.senderPeerKey,
    recipient_peer_key: fields.recipientPeerKey,
    delivery_id: fields.deliveryId,
    path_epoch: fields.pathEpoch,
    stream_id: fields.streamId,
    frame_type: fields.frameType,
    ack_requested: fields.ackRequested,
    hpke_ciphertext_bytes: boundedCiphertextBytes(fields.hpkeCiphertextBytes)
  }));
}

export function decodeBetaPayloadText(payload: Uint8Array): string {
  return textDecoder.decode(payload);
}

function decodeSealedPayload(encoded: string): EncodedSealedPayload {
  if (encoded.length > maxSealedPayloadBytes) {
    throw new Error("sealed payload too large");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(textDecoder.decode(decodeBase64URL(encoded)));
  } catch {
    throw new Error("sealed payload rejected");
  }
  if (!isEncodedSealedPayload(decoded)) {
    throw new Error("sealed payload rejected");
  }
  return decoded;
}

function boundedBytes(value: string | Uint8Array, maxBytes: number, name: string): Uint8Array {
  const bytes = typeof value === "string" ? textEncoder.encode(value) : value;
  if (bytes.byteLength > maxBytes) {
    throw new Error(`${name} too large`);
  }
  return bytes;
}

function boundedCiphertextBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < hpkeAuthenticationTagBytes || value > maxPlaintextBytes + hpkeAuthenticationTagBytes) {
    throw new Error("invalid HPKE ciphertext length");
  }
  return value;
}

function requireBase64URLBytes(value: string, size: number, name: string): void {
  if (decodeBase64URL(value).byteLength !== size) {
    throw new Error(`invalid ${name}`);
  }
}

function isEncodedSealedPayload(value: unknown): value is EncodedSealedPayload {
  return isRecord(value) &&
    value["suite_id"] === betaHpkePayloadSuiteID &&
    value["ciphersuite"] === betaHpkeCiphersuite &&
    typeof value["enc"] === "string" &&
    typeof value["ct"] === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
