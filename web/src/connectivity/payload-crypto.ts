import { Aes128Gcm, CipherSuite, HkdfSha256 } from "@hpke/core";
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519";

import { decodeBase64URL, encodeBase64URL } from "../protocol/v0/base64url.js";

export const betaHpkePayloadSuiteID = "branch.hpke/0.draft" as const;
export const betaHpkeCiphersuite = "DHKEM(X25519,HKDF-SHA256)+HKDF-SHA256+AES-128-GCM" as const;

export interface BetaPayloadKeyPair {
  readonly publicKey: string;
  readonly privateKey: CryptoKey;
}

export interface SealBetaPayloadOptions {
  readonly recipientPublicKey: string;
  readonly plaintext: string | Uint8Array;
  readonly aad: string | Uint8Array;
}

export interface OpenBetaPayloadOptions {
  readonly recipientPrivateKey: CryptoKey;
  readonly sealedPayload: string;
  readonly aad: string | Uint8Array;
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

export async function sealBetaPayload(options: SealBetaPayloadOptions): Promise<string> {
  const plaintext = boundedBytes(options.plaintext, maxPlaintextBytes, "payload plaintext");
  const aad = boundedBytes(options.aad, maxAADBytes, "payload aad");
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
  const encoded = encodeBase64URL(textEncoder.encode(JSON.stringify(payload)));
  if (encoded.length > maxSealedPayloadBytes) {
    throw new Error("sealed payload too large");
  }
  return encoded;
}

export async function openBetaPayload(options: OpenBetaPayloadOptions): Promise<Uint8Array> {
  const aad = boundedBytes(options.aad, maxAADBytes, "payload aad");
  const payload = decodeSealedPayload(options.sealedPayload);
  const plaintext = await suite.open({
    recipientKey: options.recipientPrivateKey,
    enc: decodeBase64URL(payload.enc),
    info: textEncoder.encode(betaHpkePayloadSuiteID)
  }, decodeBase64URL(payload.ct), aad);
  return new Uint8Array(plaintext);
}

export function makeBetaPayloadAAD(fields: {
  readonly protocol: string;
  readonly profileMultihash: string;
  readonly senderPeerId: string;
  readonly recipientPeerId: string;
  readonly deliveryId: string;
  readonly pathEpoch: number;
  readonly streamId: number;
  readonly frameType: "ENVELOPE";
  readonly ackRequested: boolean;
}): Uint8Array {
  return textEncoder.encode(JSON.stringify({
    ack_requested: fields.ackRequested,
    delivery_id: fields.deliveryId,
    frame_type: fields.frameType,
    path_epoch: fields.pathEpoch,
    profile_multihash: fields.profileMultihash,
    protocol: fields.protocol,
    recipient_peer_id: fields.recipientPeerId,
    sender_peer_id: fields.senderPeerId,
    stream_id: fields.streamId
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
