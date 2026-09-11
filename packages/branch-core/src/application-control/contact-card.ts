import { decodeBase64URL, encodeBase64URL } from "../protocol/v0/base64url.js";
import {
  cborMap,
  decodeDeterministicCbor,
  encodeDeterministicCbor,
  getRequiredEntry,
  readBytes,
  readCborMap,
  readText,
  rejectUnknownEntries,
  type CborMap
} from "../protocol/v0/cbor.js";
import { branchIDFromPublicKey, parseBranchID } from "../protocol/v0/identity-contact.js";

// This descriptor body travels only in an existing signed application-control
// envelope sealed by existing HPKE. It is not a relay frame or relay metadata.
export const contactCardControlKind = "branch.contact-card/0.draft" as const;
export const maxContactCardBytes = 512;
export const maxContactCardNameBytes = 96;
export const maxContactCardTTLms = 60_000;

export interface ContactCard {
  readonly requestId: string;
  readonly branchId: string;
  readonly peerId: string;
  readonly hpkePublicKey: string;
  readonly displayName: string;
}

export function encodeContactCard(card: ContactCard): Uint8Array {
  validateContactCard(card);
  const bytes = encodeDeterministicCbor(contactCardMap(card));
  if (bytes.byteLength > maxContactCardBytes) throw new Error("contact card body too large");
  return bytes;
}

export function decodeContactCard(bytes: Uint8Array): ContactCard {
  if (bytes.byteLength === 0 || bytes.byteLength > maxContactCardBytes) throw new Error("invalid contact card body size");
  const map = readCborMap(decodeDeterministicCbor(bytes, maxContactCardBytes), "contact_card");
  rejectUnknownEntries(map, ["request_id", "branch_id", "peer_id", "hpke_public_key", "display_name"]);
  const card: ContactCard = {
    requestId: encodeBase64URL(readBytes(getRequiredEntry(map, "request_id"), "request_id", 16)),
    branchId: readText(getRequiredEntry(map, "branch_id"), "branch_id"),
    peerId: encodeBase64URL(readBytes(getRequiredEntry(map, "peer_id"), "peer_id", 32)),
    hpkePublicKey: encodeBase64URL(readBytes(getRequiredEntry(map, "hpke_public_key"), "hpke_public_key", 32)),
    displayName: readText(getRequiredEntry(map, "display_name"), "display_name")
  };
  validateContactCard(card);
  return card;
}

// This is deliberately structural and clock-free. The application adapter
// later verifies the signed envelope, HPKE/AAD route sender, pending request,
// and one-use replay state.
export function validateContactCard(card: ContactCard): void {
  if (
    decodeBase64URL(card.requestId).byteLength !== 16 ||
    decodeBase64URL(card.peerId).byteLength !== 32 ||
    decodeBase64URL(card.hpkePublicKey).byteLength !== 32 ||
    new TextEncoder().encode(card.displayName).byteLength === 0 ||
    new TextEncoder().encode(card.displayName).byteLength > maxContactCardNameBytes
  ) {
    throw new Error("invalid contact card");
  }
  parseBranchID(card.branchId);
}

// A contact card's peer ID is the raw Ed25519 root public key for this live
// discovery exchange. Keep this self-certifying identity check beside the
// card's closed-body validation so adapters do not need to reproduce it.
// Signature, envelope recipient, HPKE/AAD route sender, and pending-request
// checks remain adapter-owned boundaries and must run before projection.
export async function assertContactCardBranchIDBinding(card: ContactCard): Promise<void> {
  validateContactCard(card);
  const branchId = await branchIDFromPublicKey(decodeBase64URL(card.peerId));
  if (branchId !== card.branchId) {
    throw new Error("contact card branch id mismatch");
  }
}

function contactCardMap(card: ContactCard): CborMap {
  return cborMap([
    { key: "request_id", value: decodeBase64URL(card.requestId) },
    { key: "branch_id", value: card.branchId },
    { key: "peer_id", value: decodeBase64URL(card.peerId) },
    { key: "hpke_public_key", value: decodeBase64URL(card.hpkePublicKey) },
    { key: "display_name", value: card.displayName }
  ]);
}
