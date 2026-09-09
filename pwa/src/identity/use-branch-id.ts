import { useEffect, useState } from "react";

import { branchIDFromPeerId } from "./branch-id.js";

// Works for the local identity's own peerId or any contact's stored peerId —
// both are the same raw Ed25519 public key shape.
export function useBranchID(peerId: string | null): string | null {
  const [branchID, setBranchID] = useState<string | null>(null);

  useEffect(() => {
    if (peerId === null) {
      setBranchID(null);
      return;
    }
    let cancelled = false;
    branchIDFromPeerId(peerId)
      .then((value) => {
        if (!cancelled) {
          setBranchID(value);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setBranchID(null);
        }
      });
    return () => { cancelled = true; };
  }, [peerId]);

  return branchID;
}
