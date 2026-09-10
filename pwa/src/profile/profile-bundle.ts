import {
  betaHpkeCiphertextBytesForPlaintext,
  decodeBase64URL,
  exportBetaPayloadKeyPair,
  importBetaPayloadKeyPair,
  openBetaPayload,
  sealBetaPayload
} from "@code4bones/branch-core";

import { validateDisplayName, validateHpkePublicKey, validatePeerID } from "../connectivity/message-payload.js";
import type { ContactSummary } from "../state/slices/contacts-slice.js";
import type { MessageSummary } from "../state/slices/conversations-slice.js";
import type { IncomingMessageRequest } from "../state/slices/message-requests-slice.js";
import type { StoredIdentityRecord } from "../storage/identity-store.js";

// This is a local PWA recovery/migration container, deliberately unrelated to
// a B.R.A.N.C.H. wire version. It is never handed to a relay or carrier.
export const portableProfileFormat = "branch.pwa.profile-export/0.draft" as const;
export const portableProfileVersion = 1 as const;
export const portableProfileKdf = "PBKDF2-SHA-256" as const;
export const portableProfileCipher = "AES-256-GCM" as const;
export const portableProfilePbkdf2Iterations = 600_000;
const gcmTagBytes = 16;
export const maxPortableProfileBytes = 16 * 1024 * 1024;
// Ciphertext is base64url JSON, so the file itself is safely bounded above
// the decrypted 16 MiB payload limit without reducing usable history.
export const maxPortableProfileFileBytes = Math.ceil((maxPortableProfileBytes + gcmTagBytes) * 4 / 3) + 4_096;

const saltBytes = 16;
const ivBytes = 12;
const maxContacts = 5_000;
const maxMessages = 50_000;
const maxMessageRequests = 50;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export interface PortableProfileSnapshot {
  readonly identity: StoredIdentityRecord;
  readonly contacts: readonly ContactSummary[];
  readonly messages: readonly MessageSummary[];
  readonly readState: Readonly<Record<string, number>>;
  readonly messageRequests: readonly IncomingMessageRequest[];
}

interface PortableIdentityPayload {
  readonly peerId: string;
  readonly relayPublicKey: string;
  readonly relayPrivateKeyJwk: { readonly kty: "OKP"; readonly crv: "Ed25519"; readonly x: string; readonly d: string };
  readonly hpkePublicKey: string;
  readonly hpkePrivateKey: string;
  readonly displayName: string | null;
  readonly createdAt: number;
}

interface PortableProfilePayload {
  readonly identity: PortableIdentityPayload;
  readonly contacts: readonly ContactSummary[];
  readonly messages: readonly MessageSummary[];
  readonly readState: Readonly<Record<string, number>>;
  readonly messageRequests: readonly IncomingMessageRequest[];
}

interface PortableProfileEnvelopeHeader {
  readonly format: typeof portableProfileFormat;
  readonly version: typeof portableProfileVersion;
  readonly kdf: typeof portableProfileKdf;
  readonly iterations: typeof portableProfilePbkdf2Iterations;
  readonly salt: string;
  readonly cipher: typeof portableProfileCipher;
  readonly iv: string;
}

interface PortableProfileEnvelope extends PortableProfileEnvelopeHeader {
  readonly ciphertext: string;
}

export async function encryptPortableProfile(snapshot: PortableProfileSnapshot, password: string): Promise<string> {
  requirePassword(password);
  const payload = await serializeSnapshot(snapshot);
  const plaintext = textEncoder.encode(JSON.stringify(payload));
  if (plaintext.byteLength > maxPortableProfileBytes) {
    throw new Error("profile export exceeds the 16 MiB limit");
  }
  const salt = crypto.getRandomValues(new Uint8Array(saltBytes));
  const iv = crypto.getRandomValues(new Uint8Array(ivBytes));
  const header: PortableProfileEnvelopeHeader = {
    format: portableProfileFormat,
    version: portableProfileVersion,
    kdf: portableProfileKdf,
    iterations: portableProfilePbkdf2Iterations,
    salt: encodeBase64URL(salt),
    cipher: portableProfileCipher,
    iv: encodeBase64URL(iv)
  };
  const key = await deriveEncryptionKey(password, salt);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: textEncoder.encode(JSON.stringify(header)) },
    key,
    plaintext
  );
  const result: PortableProfileEnvelope = { ...header, ciphertext: encodeBase64URL(new Uint8Array(ciphertext)) };
  const encoded = JSON.stringify(result);
  if (textEncoder.encode(encoded).byteLength > maxPortableProfileFileBytes) {
    throw new Error("profile export exceeds the 16 MiB limit");
  }
  return encoded;
}

export async function decryptPortableProfile(encoded: string, password: string): Promise<PortableProfileSnapshot> {
  requirePassword(password);
  if (textEncoder.encode(encoded).byteLength > maxPortableProfileFileBytes) {
    throw new Error("profile file exceeds the encrypted-file limit");
  }
  const envelope = parseEnvelope(encoded);
  try {
    const salt = decodeExactBase64URL(envelope.salt, saltBytes);
    const iv = decodeExactBase64URL(envelope.iv, ivBytes);
    const ciphertext = decodeBase64URLStrict(envelope.ciphertext);
    if (ciphertext.byteLength <= gcmTagBytes || ciphertext.byteLength > maxPortableProfileBytes + gcmTagBytes) {
      throw new Error("invalid ciphertext length");
    }
    const key = await deriveEncryptionKey(password, salt);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: exactArrayBuffer(iv), additionalData: exactArrayBuffer(textEncoder.encode(JSON.stringify(toHeader(envelope)))) },
      key,
      exactArrayBuffer(ciphertext)
    );
    if (plaintext.byteLength > maxPortableProfileBytes) {
      throw new Error("invalid plaintext length");
    }
    return await parsePayload(textDecoder.decode(plaintext));
  } catch {
    // The same generic result avoids turning this local import UI into a
    // password or ciphertext oracle. No IndexedDB operation has happened.
    throw new Error("profile file could not be decrypted or verified");
  }
}

async function serializeSnapshot(snapshot: PortableProfileSnapshot): Promise<PortableProfilePayload> {
  validateSnapshotRecords(snapshot.contacts, snapshot.messages, snapshot.readState, snapshot.messageRequests);
  const jwk = await crypto.subtle.exportKey("jwk", snapshot.identity.relayPrivateKey);
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string" || typeof jwk.d !== "string") {
    throw new Error("local relay identity cannot be exported");
  }
  const hpke = await exportBetaPayloadKeyPair({
    publicKey: snapshot.identity.hpkePublicKey,
    privateKey: snapshot.identity.hpkePrivateKey
  });
  const identity: PortableIdentityPayload = {
    peerId: snapshot.identity.peerId,
    relayPublicKey: snapshot.identity.relayPublicKey,
    relayPrivateKeyJwk: { kty: "OKP", crv: "Ed25519", x: jwk.x, d: jwk.d },
    hpkePublicKey: hpke.publicKey,
    hpkePrivateKey: hpke.privateKey,
    displayName: snapshot.identity.displayName,
    createdAt: snapshot.identity.createdAt
  };
  validatePortableIdentity(identity);
  return { identity, contacts: snapshot.contacts, messages: snapshot.messages, readState: snapshot.readState, messageRequests: snapshot.messageRequests };
}

async function parsePayload(encoded: string): Promise<PortableProfileSnapshot> {
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw new Error("invalid payload");
  }
  if (!isExactRecord(value, ["identity", "contacts", "messages", "readState", "messageRequests"])) {
    throw new Error("invalid payload");
  }
  const identity = parsePortableIdentity(value.identity);
  const contacts = parseContacts(value.contacts);
  const messages = parseMessages(value.messages);
  const readState = parseReadState(value.readState);
  const messageRequests = parseMessageRequests(value.messageRequests);
  validateSnapshotRecords(contacts, messages, readState, messageRequests);
  const relayPrivateKey = await crypto.subtle.importKey("jwk", identity.relayPrivateKeyJwk, "Ed25519", true, ["sign"]);
  const hpke = await importBetaPayloadKeyPair({ publicKey: identity.hpkePublicKey, privateKey: identity.hpkePrivateKey });
  await verifyHpkeKeyPair(identity.hpkePublicKey, hpke.privateKey);
  return {
    identity: {
      peerId: identity.peerId,
      relayPublicKey: identity.relayPublicKey,
      relayPrivateKey,
      hpkePublicKey: hpke.publicKey,
      hpkePrivateKey: hpke.privateKey,
      displayName: identity.displayName,
      createdAt: identity.createdAt
    },
    contacts,
    messages,
    readState,
    messageRequests
  };
}

async function verifyHpkeKeyPair(publicKey: string, privateKey: CryptoKey): Promise<void> {
  const probe = new Uint8Array([66, 82, 65, 78, 67, 72]);
  const aad = "branch.pwa.profile-export/0.key-check";
  const expectedCiphertextBytes = betaHpkeCiphertextBytesForPlaintext(probe);
  const sealed = await sealBetaPayload({ recipientPublicKey: publicKey, plaintext: probe, aad, expectedCiphertextBytes });
  const opened = await openBetaPayload({ recipientPrivateKey: privateKey, sealedPayload: sealed, aad, expectedCiphertextBytes });
  if (opened.byteLength !== probe.byteLength || !opened.every((value, index) => value === probe[index])) {
    throw new Error("invalid profile payload identity");
  }
}

function parseEnvelope(encoded: string): PortableProfileEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw new Error("invalid profile envelope");
  }
  if (!isExactRecord(value, ["format", "version", "kdf", "iterations", "salt", "cipher", "iv", "ciphertext"]) ||
    value.format !== portableProfileFormat || value.version !== portableProfileVersion || value.kdf !== portableProfileKdf ||
    value.iterations !== portableProfilePbkdf2Iterations || value.cipher !== portableProfileCipher ||
    typeof value.salt !== "string" || typeof value.iv !== "string" || typeof value.ciphertext !== "string") {
    throw new Error("invalid profile envelope");
  }
  return value as unknown as PortableProfileEnvelope;
}

function toHeader(value: PortableProfileEnvelope): PortableProfileEnvelopeHeader {
  return { format: value.format, version: value.version, kdf: value.kdf, iterations: value.iterations, salt: value.salt, cipher: value.cipher, iv: value.iv };
}

function parsePortableIdentity(value: unknown): PortableIdentityPayload {
  if (!isExactRecord(value, ["peerId", "relayPublicKey", "relayPrivateKeyJwk", "hpkePublicKey", "hpkePrivateKey", "displayName", "createdAt"]) ||
    typeof value.peerId !== "string" || typeof value.relayPublicKey !== "string" || typeof value.hpkePublicKey !== "string" ||
    typeof value.hpkePrivateKey !== "string" || (value.displayName !== null && typeof value.displayName !== "string") || !validTimestamp(value.createdAt) ||
    !isExactRecord(value.relayPrivateKeyJwk, ["kty", "crv", "x", "d"]) || value.relayPrivateKeyJwk.kty !== "OKP" ||
    value.relayPrivateKeyJwk.crv !== "Ed25519" || typeof value.relayPrivateKeyJwk.x !== "string" || typeof value.relayPrivateKeyJwk.d !== "string") {
    throw new Error("invalid profile identity");
  }
  const identity: PortableIdentityPayload = {
    peerId: value.peerId,
    relayPublicKey: value.relayPublicKey,
    relayPrivateKeyJwk: { kty: "OKP", crv: "Ed25519", x: value.relayPrivateKeyJwk.x, d: value.relayPrivateKeyJwk.d },
    hpkePublicKey: value.hpkePublicKey,
    hpkePrivateKey: value.hpkePrivateKey,
    displayName: value.displayName,
    createdAt: value.createdAt
  };
  validatePortableIdentity(identity);
  return identity;
}

function validatePortableIdentity(identity: PortableIdentityPayload): void {
  validatePeerID(identity.peerId);
  if (identity.peerId !== identity.relayPublicKey || identity.relayPrivateKeyJwk.x !== identity.relayPublicKey) {
    throw new Error("invalid profile relay identity");
  }
  validateHpkePublicKey(identity.hpkePublicKey);
  if (identity.displayName !== null) {
    validateDisplayName(identity.displayName);
  }
  if (!validTimestamp(identity.createdAt)) {
    throw new Error("invalid profile creation time");
  }
}

function parseContacts(value: unknown): readonly ContactSummary[] {
  if (!Array.isArray(value) || value.length > maxContacts) {
    throw new Error("invalid profile contacts");
  }
  return value.map((contact) => {
    if (!isExactRecord(contact, ["contactId", "displayName", "peerId", "hpkePublicKey", "lastRouteHint"]) ||
      !nonemptyText(contact.contactId, 128) || !nonemptyText(contact.displayName, 80) ||
      (contact.peerId !== null && typeof contact.peerId !== "string") || (contact.hpkePublicKey !== null && typeof contact.hpkePublicKey !== "string") ||
      (contact.lastRouteHint !== null && !nonemptyText(contact.lastRouteHint, 2_048))) {
      throw new Error("invalid profile contact");
    }
    if ((contact.peerId === null) !== (contact.hpkePublicKey === null)) {
      throw new Error("invalid profile contact");
    }
    if (contact.peerId !== null) validatePeerID(contact.peerId);
    if (contact.hpkePublicKey !== null) validateHpkePublicKey(contact.hpkePublicKey);
    return contact as unknown as ContactSummary;
  });
}

function parseMessages(value: unknown): readonly MessageSummary[] {
  const directions = new Set(["outgoing", "incoming", "service"]);
  const states = new Set(["pending", "relayed", "delivered", "read", "received", "unavailable"]);
  if (!Array.isArray(value) || value.length > maxMessages) throw new Error("invalid profile messages");
  return value.map((message) => {
    if (!isExactRecord(message, ["messageId", "contactId", "direction", "body", "sentAt", "deliveryState"]) ||
      !nonemptyText(message.messageId, 128) || !nonemptyText(message.contactId, 128) || typeof message.body !== "string" ||
      textEncoder.encode(message.body).byteLength > 3_000 || !validTimestamp(message.sentAt) ||
      typeof message.direction !== "string" || !directions.has(message.direction) || typeof message.deliveryState !== "string" || !states.has(message.deliveryState)) {
      throw new Error("invalid profile message");
    }
    return message as unknown as MessageSummary;
  });
}

function parseReadState(value: unknown): Readonly<Record<string, number>> {
  if (!isRecord(value) || Object.keys(value).length > maxContacts) throw new Error("invalid profile read state");
  for (const [contactId, timestamp] of Object.entries(value)) {
    if (!nonemptyText(contactId, 128) || !validTimestamp(timestamp)) throw new Error("invalid profile read state");
  }
  return value as Record<string, number>;
}

function parseMessageRequests(value: unknown): readonly IncomingMessageRequest[] {
  if (!Array.isArray(value) || value.length > maxMessageRequests) throw new Error("invalid profile requests");
  return value.map((request) => {
    if (!isExactRecord(request, ["requestId", "senderPeerId", "senderHpkePublicKey", "senderDisplayName", "body", "receivedAt"]) ||
      !nonemptyText(request.requestId, 128) || typeof request.senderPeerId !== "string" || typeof request.senderHpkePublicKey !== "string" ||
      !nonemptyText(request.senderDisplayName, 80) || typeof request.body !== "string" || textEncoder.encode(request.body).byteLength > 3_000 || !validTimestamp(request.receivedAt)) {
      throw new Error("invalid profile request");
    }
    validatePeerID(request.senderPeerId);
    validateHpkePublicKey(request.senderHpkePublicKey);
    validateDisplayName(request.senderDisplayName);
    return request as unknown as IncomingMessageRequest;
  });
}

function validateSnapshotRecords(contacts: readonly ContactSummary[], messages: readonly MessageSummary[], readState: Readonly<Record<string, number>>, requests: readonly IncomingMessageRequest[]): void {
  const contactIds = new Set<string>();
  for (const contact of contacts) {
    if (contactIds.has(contact.contactId)) throw new Error("duplicate profile contact");
    contactIds.add(contact.contactId);
  }
  const messageIds = new Set<string>();
  for (const message of messages) {
    if (messageIds.has(message.messageId) || !contactIds.has(message.contactId)) throw new Error("invalid profile message relation");
    messageIds.add(message.messageId);
  }
  for (const contactId of Object.keys(readState)) {
    if (!contactIds.has(contactId)) throw new Error("invalid profile read-state relation");
  }
  const requestIds = new Set<string>();
  for (const request of requests) {
    if (requestIds.has(request.requestId)) throw new Error("duplicate profile request");
    requestIds.add(request.requestId);
  }
}

async function deriveEncryptionKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", textEncoder.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: exactArrayBuffer(salt), iterations: portableProfilePbkdf2Iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

function requirePassword(password: string): void {
  if (textEncoder.encode(password).byteLength < 12 || textEncoder.encode(password).byteLength > 1_024) {
    throw new Error("use a password between 12 and 1024 UTF-8 bytes");
  }
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function nonemptyText(value: unknown, maximumBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && textEncoder.encode(value).byteLength <= maximumBytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function decodeExactBase64URL(value: string, expectedBytes: number): Uint8Array {
  const decoded = decodeBase64URLStrict(value);
  if (decoded.byteLength !== expectedBytes) throw new Error("invalid base64url length");
  return decoded;
}

function decodeBase64URLStrict(value: string): Uint8Array {
  if (value.length === 0 || value.length > maxPortableProfileBytes * 2 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("invalid base64url");
  }
  return decodeBase64URL(value);
}

function encodeBase64URL(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunk)));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function exactArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}
