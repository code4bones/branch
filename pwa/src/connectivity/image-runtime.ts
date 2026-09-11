import {
  hasRasterImageMagic,
  maxImageRelayBytes,
  maxImagePixels,
  maxImageHeight,
  maxImageWidth,
  maxImageCaptionBytes,
  imageCapabilitiesControlKind,
  type RasterImageMediaType
} from "@code4bones/branch-core";

import { stageVerifiedImageMessage } from "../app/image-message-presentation.js";
import { isAcceptedImageMediaType, type ImageInput } from "../app/image-message.js";
import { deleteStoredImageMessages } from "../storage/image-media-store.js";
import type { AppStoreApi } from "../state/store.js";
import { ImageCapabilitiesController, defaultImageCapabilities } from "./image-capabilities-control.js";
import { ImageTransferController, type ImageIncomingResult } from "./image-transfer.js";
import { hasAttachedRelaySession } from "./relay-session.js";
import { createDeliveryID, sendApplicationPayload } from "./seal-and-send.js";
import { decodeBase64URL } from "@code4bones/branch-core";
import { getLocalIdentityKeys } from "../identity/identity-keys.js";

const preferredImageType: RasterImageMediaType = "image/webp";
const localMaximumDimension = 2_048;
const localMaximumPixels = 4 * 1024 * 1024;
const peerCapabilityWaitMs = 2_000;
const peerCapabilityPollMs = 50;

export type ImageMessageSendResult =
  | { readonly status: "sent"; readonly mode: "inline" | "transfer" }
  | { readonly status: "rejected"; readonly reason: "unsupported" | "unavailable" | "busy" | "send_failed" | "invalid_image" | "storage" };

interface ActiveImageRuntime {
  readonly storeApi: AppStoreApi;
  readonly capabilities: ImageCapabilitiesController;
  readonly transfers: ImageTransferController;
}

let active: ActiveImageRuntime | null = null;

/** Installs only tab-volatile capability and image-transfer state. */
export function imageTransferController(storeApi: AppStoreApi): ImageTransferController {
  return imageRuntime(storeApi).transfers;
}

export async function receiveImageCapabilities(storeApi: AppStoreApi, peerId: string, plaintext: Uint8Array): Promise<{ readonly handled: boolean; readonly outcome?: string }> {
  const runtime = imageRuntime(storeApi);
  const received = await runtime.capabilities.receive(peerId, plaintext);
  return { handled: received.handled, ...(received.outcome === undefined ? {} : { outcome: received.outcome }) };
}

export async function advertiseImageCapabilities(storeApi: AppStoreApi, peerId: string): Promise<"sent" | "skipped"> {
  if (!hasAttachedRelaySession()) return "skipped";
  return await imageRuntime(storeApi).capabilities.advertise(peerId);
}

export function hasAdvertisedImageCapabilities(storeApi: AppStoreApi, peerId: string): boolean {
  return imageRuntime(storeApi).capabilities.hasAdvertised(peerId);
}

export function shouldReplyToImageCapabilities(storeApi: AppStoreApi, peerId: string): boolean {
  return imageRuntime(storeApi).capabilities.shouldReplyTo(peerId);
}

/**
 * Normalizes a user-selected raster before it becomes an endpoint image.
 * The re-encode strips EXIF and guarantees the declared output format matches
 * the bytes; the original File never enters app state or transport metadata.
 */
export async function sendLocalImageInput(storeApi: AppStoreApi, contactId: string, peerId: string, input: ImageInput, caption: string = "", replyToMessageId?: string): Promise<ImageMessageSendResult> {
  if (!hasAttachedRelaySession()) return { status: "rejected", reason: "unavailable" };
  const normalizedCaption = caption.trim();
  if (new TextEncoder().encode(normalizedCaption).byteLength > maxImageCaptionBytes) return { status: "rejected", reason: "invalid_image" };
  // A paste is the initiating action for a new live chat too. Wait briefly for
  // the signed, receiver-owned answer instead of requiring users to paste a
  // second time after the chat's best-effort capability bootstrap races it.
  if (!await waitForPeerImageCapabilities(storeApi, peerId)) return { status: "rejected", reason: "unsupported" };
  const normalized = await normalizeRasterInput(input.file);
  if (normalized === null) return { status: "rejected", reason: "invalid_image" };
  const messageId = createDeliveryID();
  const projection = {
    messageId,
    contactId,
    direction: "outgoing" as const,
    sentAt: Date.now(),
    mediaType: normalized.mediaType,
    byteCount: normalized.bytes.byteLength,
    width: normalized.width,
    height: normalized.height,
    ...(normalizedCaption === "" ? {} : { caption: normalizedCaption }),
    ...(replyToMessageId === undefined ? {} : { replyToMessageId })
  };
  const staged = await stageVerifiedImageMessage(storeApi, { projection, bytes: normalized.bytes });
  if (staged !== "stored" && staged !== "already_stored") return { status: "rejected", reason: "storage" };
  const result = await imageTransferController(storeApi).sendImage({
    peerId,
    route: "relay",
    messageId,
    mediaType: normalized.mediaType,
    width: normalized.width,
    height: normalized.height,
    bytes: normalized.bytes,
    ...(normalizedCaption === "" ? {} : { caption: normalizedCaption }),
    ...(replyToMessageId === undefined ? {} : { replyToMessageId })
  });
  if (result.status === "sent") return { status: "sent", mode: result.mode };
  storeApi.getState().removeImageMessageProjections([messageId]);
  void deleteStoredImageMessages([messageId]).catch(() => {});
  return { status: "rejected", reason: result.reason === "unknown_peer" ? "unavailable" : result.reason };
}

export async function receiveImagePayload(storeApi: AppStoreApi, peerId: string, plaintext: Uint8Array): Promise<ImageIncomingResult> {
  return await imageTransferController(storeApi).receive(peerId, plaintext);
}

export function clearImageRuntime(): void {
  active?.capabilities.clear();
  active?.transfers.close();
  active = null;
}

/**
 * Starts a receiver-consent exchange for the current user action and waits
 * only within a short bounded foreground window. No image bytes are retained
 * during the wait, and a peer that has not upgraded remains unavailable.
 */
async function waitForPeerImageCapabilities(storeApi: AppStoreApi, peerId: string): Promise<boolean> {
  const runtime = imageRuntime(storeApi);
  if (runtime.capabilities.peerCapabilities(peerId) !== null) return true;
  await advertiseImageCapabilities(storeApi, peerId);
  const deadline = Date.now() + peerCapabilityWaitMs;
  while (Date.now() < deadline) {
    await delay(peerCapabilityPollMs);
    if (runtime.capabilities.peerCapabilities(peerId) !== null) return true;
  }
  return false;
}

function imageRuntime(storeApi: AppStoreApi): ActiveImageRuntime {
  if (active?.storeApi === storeApi) return active;
  clearImageRuntime();
  const capabilities = new ImageCapabilitiesController({
    now: () => Date.now(),
    randomBytes: (bytes) => crypto.getRandomValues(bytes),
    localPeerId: () => storeApi.getState().identity?.peerId ?? "",
    localSigningKey: () => getLocalIdentityKeys()?.relayPrivateKey ?? null,
    isKnownPeer: (peerId) => knownContact(storeApi, peerId) !== null,
    knownPeerSigningKey: async (peerId) => await knownPeerSigningKey(storeApi, peerId),
    localCapabilities: defaultImageCapabilities,
    send: async ({ peerId, plaintext }) => { await sendToKnownPeer(storeApi, peerId, plaintext); }
  });
  const transfers = new ImageTransferController({
    now: () => Date.now(),
    randomBytes: (bytes) => crypto.getRandomValues(bytes),
    localSigningKey: () => getLocalIdentityKeys()?.relayPrivateKey ?? null,
    isKnownPeer: (peerId) => knownContact(storeApi, peerId) !== null,
    knownPeerSigningKey: async (peerId) => await knownPeerSigningKey(storeApi, peerId),
    peerCapabilities: (peerId) => capabilities.peerCapabilities(peerId),
    inboundCapabilities: (peerId, requiredCapability) =>
      requiredCapability === imageCapabilitiesControlKind ? capabilities.inboundCapabilities(peerId) : null,
    send: async ({ peerId, plaintext }) => { await sendToKnownPeer(storeApi, peerId, plaintext); },
    timers: { schedule: (delayMs, callback) => setTimeout(callback, delayMs), cancel: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); } },
    verifyRaster: verifyRaster,
    onImage: async (image) => {
      const contact = knownContact(storeApi, image.peerId);
      if (contact === null) return;
      const staged = await stageVerifiedImageMessage(storeApi, {
        projection: {
          messageId: image.messageId,
          contactId: contact.contactId,
          direction: "incoming",
          sentAt: Date.now(),
          mediaType: image.mediaType,
          byteCount: image.bytes.byteLength,
          width: image.width,
          height: image.height,
          ...(image.caption === undefined ? {} : { caption: image.caption }),
          ...(image.replyToMessageId === undefined ? {} : { replyToMessageId: image.replyToMessageId })
        },
        bytes: image.bytes
      });
      if (staged !== "stored" && staged !== "already_stored") throw new Error("image projection unavailable");
    },
    onEvent: (event) => { storeApi.getState().recordTransportTrace(`image: ${event.event} ${event.direction} ${event.reason}`); }
  });
  active = { storeApi, capabilities, transfers };
  return active;
}

async function sendToKnownPeer(storeApi: AppStoreApi, peerId: string, plaintext: Uint8Array): Promise<void> {
  const identity = storeApi.getState().identity;
  const contact = knownContact(storeApi, peerId);
  if (identity === null || contact === null || contact.hpkePublicKey === null || !hasAttachedRelaySession()) throw new Error("image peer unavailable");
  await sendApplicationPayload({
    senderPeerId: identity.peerId,
    recipientPeerId: peerId,
    recipientHpkePublicKey: contact.hpkePublicKey,
    deliveryId: createDeliveryID(),
    plaintext
  });
}

async function normalizeRasterInput(file: File): Promise<{ readonly mediaType: RasterImageMediaType; readonly width: number; readonly height: number; readonly bytes: Uint8Array } | null> {
  if (!isAcceptedImageMediaType(file.type) || file.size <= 0 || file.size > maxImageRelayBytes) return null;
  const original = new Uint8Array(await file.arrayBuffer());
  if (!hasRasterImageMagic(file.type, original) || isAnimatedRaster(file.type, original)) return null;
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(new Blob([arrayBuffer(original)], { type: file.type })); } catch { return null; }
  try {
    const dimensions = boundedDimensions(bitmap.width, bitmap.height);
    if (dimensions === null) return null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const blob = await reencodeBitmap(bitmap, dimensions.width >> attempt || 1, dimensions.height >> attempt || 1);
      if (blob === null || blob.size <= 0 || blob.size > maxImageRelayBytes) continue;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (hasRasterImageMagic(preferredImageType, bytes) && !isAnimatedRaster(preferredImageType, bytes)) {
        return { mediaType: preferredImageType, width: dimensions.width >> attempt || 1, height: dimensions.height >> attempt || 1, bytes };
      }
    }
    return null;
  } finally { bitmap.close(); }
}

async function verifyRaster(image: { readonly mediaType: RasterImageMediaType; readonly width: number; readonly height: number; readonly bytes: Uint8Array }): Promise<boolean> {
  if (!hasRasterImageMagic(image.mediaType, image.bytes) || isAnimatedRaster(image.mediaType, image.bytes)) return false;
  try {
    const bitmap = await createImageBitmap(new Blob([arrayBuffer(image.bytes)], { type: image.mediaType }));
    try { return bitmap.width === image.width && bitmap.height === image.height && boundedDimensions(bitmap.width, bitmap.height) !== null; } finally { bitmap.close(); }
  } catch { return false; }
}

function boundedDimensions(width: number, height: number): { readonly width: number; readonly height: number } | null {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > maxImageWidth || height > maxImageHeight || width * height > maxImagePixels) return null;
  const scale = Math.min(1, localMaximumDimension / width, localMaximumDimension / height, Math.sqrt(localMaximumPixels / (width * height)));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

async function reencodeBitmap(bitmap: ImageBitmap, width: number, height: number): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  if (context === null) return null;
  context.drawImage(bitmap, 0, 0, width, height);
  return await new Promise((resolve) => { canvas.toBlob(resolve, preferredImageType, 0.84); });
}

function isAnimatedRaster(mediaType: RasterImageMediaType, bytes: Uint8Array): boolean {
  if (mediaType === "image/png") return includesAscii(bytes, "acTL");
  return mediaType === "image/webp" && includesAscii(bytes, "ANIM");
}

function includesAscii(bytes: Uint8Array, text: string): boolean {
  const needle = new TextEncoder().encode(text);
  for (let index = 0; index + needle.byteLength <= bytes.byteLength; index += 1) {
    if (needle.every((value, offset) => bytes[index + offset] === value)) return true;
  }
  return false;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

function knownContact(storeApi: AppStoreApi, peerId: string) {
  return storeApi.getState().contacts.find((candidate) => candidate.peerId === peerId && candidate.hpkePublicKey !== null) ?? null;
}

async function knownPeerSigningKey(storeApi: AppStoreApi, peerId: string): Promise<CryptoKey | null> {
  if (knownContact(storeApi, peerId) === null) return null;
  try {
    const raw = decodeBase64URL(peerId);
    return raw.byteLength === 32 ? await crypto.subtle.importKey("raw", new Uint8Array(raw).buffer, "Ed25519", false, ["verify"]) : null;
  } catch { return null; }
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}
