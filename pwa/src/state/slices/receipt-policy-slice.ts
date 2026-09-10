import type { StateCreator } from "zustand";

import type { AppStore } from "../store.js";
import { saveStoredReadReceiptPolicy } from "../../storage/receipt-policy-store.js";

export interface ReceiptPolicySlice {
  // This is a device-local disclosure preference, never relay-visible policy.
  readonly sendReadReceipts: boolean;
  readonly setSendReadReceipts: (enabled: boolean) => void;
}

export const createReceiptPolicySlice: StateCreator<AppStore, [], [], ReceiptPolicySlice> = (set) => ({
  sendReadReceipts: true,
  setSendReadReceipts: (sendReadReceipts) => {
    set({ sendReadReceipts });
    void saveStoredReadReceiptPolicy(sendReadReceipts).catch(() => {
      // Private browsing may reject IndexedDB. Keep the deliberate local
      // setting for this session; it never changes transport behaviour alone.
    });
  }
});
