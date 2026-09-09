// Session-only holder for the private halves of the local identity. Deliberately
// not part of the Zustand store: docs/ENGINEERING.md is explicit that Zustand
// holds presentation/UI state, never keys. Future sealing/attachment code reads
// these directly instead of threading CryptoKeys through component state.

export interface LocalIdentityKeys {
  readonly relayPrivateKey: CryptoKey;
  readonly hpkePrivateKey: CryptoKey;
}

let currentKeys: LocalIdentityKeys | null = null;

export function setLocalIdentityKeys(keys: LocalIdentityKeys | null): void {
  currentKeys = keys;
}

export function getLocalIdentityKeys(): LocalIdentityKeys | null {
  return currentKeys;
}
