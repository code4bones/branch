import {
  applicationControlSigningBytes,
  applicationControlWireVersion,
  assertContactCardBranchIDBinding,
  branchIDFromPublicKey,
  contactCardControlKind,
  decodeApplicationControl,
  decodeBase64URL,
  decodeContactCard,
  encodeApplicationControl,
  encodeContactCard,
  type ContactCard
} from "@code4bones/branch-core";

import { getLocalIdentityKeys } from "../identity/identity-keys.js";
import { createDeliveryID, sendApplicationControl } from "./seal-and-send.js";

const maximumClockSkewMs = 1_000;

// This is intentionally separate from the normal application-control runtime:
// a contact card is the one bounded, probe-correlated control that must be
// accepted before its sender is a known contact. It does not relax normal
// unknown-contact admission for typing, receipts, attachments, or messages.
export async function respondToContactProbe(options: {
  readonly requestId: string;
  readonly branchId: string;
  readonly requesterPeerId: string;
  readonly requesterHpkePublicKey: string;
  readonly expiresAt: number;
  readonly localPeerId: string;
  readonly localHpkePublicKey: string;
  readonly displayName: string;
}): Promise<boolean> {
  const keys = getLocalIdentityKeys();
  const now = Date.now();
  if (keys === null || options.expiresAt <= now) return false;
  const localBranchId = await branchIDFromPublicKey(decodeBase64URL(options.localPeerId));
  if (localBranchId !== options.branchId) return false;
  const expiresAt = Math.min(options.expiresAt, now + 60_000);
  const unsigned = {
    version: applicationControlWireVersion,
    kind: contactCardControlKind,
    controlId: createDeliveryID(),
    issuedAt: now,
    expiresAt,
    senderPeerId: options.localPeerId,
    recipientPeerId: options.requesterPeerId,
    body: encodeContactCard({
      requestId: options.requestId,
      branchId: options.branchId,
      peerId: options.localPeerId,
      hpkePublicKey: options.localHpkePublicKey,
      displayName: options.displayName
    })
  };
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", keys.relayPrivateKey, arrayBuffer(applicationControlSigningBytes(unsigned))));
  await sendApplicationControl({
    senderPeerId: options.localPeerId,
    recipientPeerId: options.requesterPeerId,
    recipientHpkePublicKey: options.requesterHpkePublicKey,
    plaintext: encodeApplicationControl({ ...unsigned, signature })
  });
  return true;
}

export async function receiveContactCard(options: {
  readonly plaintext: Uint8Array;
  readonly localPeerId: string;
  readonly senderPeerId: string;
}): Promise<ContactCard | null> {
  let envelope: ReturnType<typeof decodeApplicationControl>;
  try { envelope = decodeApplicationControl(options.plaintext); } catch { return null; }
  if (envelope.kind !== contactCardControlKind || envelope.recipientPeerId !== options.localPeerId || envelope.senderPeerId !== options.senderPeerId) return null;
  const now = Date.now();
  if (envelope.expiresAt <= now || envelope.issuedAt > now + maximumClockSkewMs || envelope.expiresAt - envelope.issuedAt > 60_000) return null;
  try {
    const publicKey = await crypto.subtle.importKey("raw", arrayBuffer(decodeBase64URL(options.senderPeerId)), "Ed25519", false, ["verify"]);
    if (!await crypto.subtle.verify("Ed25519", publicKey, arrayBuffer(envelope.signature), arrayBuffer(applicationControlSigningBytes(envelope)))) return null;
    const card = decodeContactCard(envelope.body);
    if (card.peerId !== options.senderPeerId) return null;
    await assertContactCardBranchIDBinding(card);
    return card;
  } catch { return null; }
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}
