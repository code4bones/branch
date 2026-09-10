import type { StateCreator } from "zustand";

import type { AppStore } from "../store.js";
import { saveStoredReadReceiptPolicy } from "../../storage/receipt-policy-store.js";

export interface ReceiptPolicySlice {
  // Privacy-safe default: enabling best-effort Read controls is an explicit
  // decision made on this device, not a property advertised to a relay.
  readonly sendReadReceipts: boolean;
  readonly setSendReadReceipts: (enabled: boolean) => void;
}

export const createReceiptPolicySlice: StateCreator<AppStore, [], [], ReceiptPolicySlice> = (set) => ({
  sendReadReceipts: false,
  setSendReadReceipts: (sendReadReceipts) => {
    set({ sendReadReceipts });
    void saveStoredReadReceiptPolicy(sendReadReceipts).catch(() => {
      // Private browsing may reject IndexedDB. Keep the deliberate local
      // setting for this session; it never changes transport behaviour alone.
    });
  }
});
