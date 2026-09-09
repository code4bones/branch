import { branchIDFromPublicKey, decodeBase64URL } from "@code4bones/branch-core";

// BranchID is self-certifying: it's a hash of an Ed25519 public key, not a
// separate identifier to mint or store. Both the local identity's own
// relayPublicKey and any contact's stored peerId are that same raw Ed25519
// public key (base64url-encoded), so this one function derives either.
export async function branchIDFromPeerId(peerId: string): Promise<string> {
  return branchIDFromPublicKey(decodeBase64URL(peerId));
}
