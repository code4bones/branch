import type { IdentityContactRouteHint } from "@code4bones/branch-core";
import { Button } from "antd";
import { useState } from "react";

import { lookupIdentityContactViaGitHub } from "../discovery/lookup-identity-contact.js";
import { useBranchID } from "../identity/use-branch-id.js";

type LookupStatus = "idle" | "pending" | "accepted" | "rejected" | "error";

// Diagnostic/informational only (T-BRANCH-107): looks up this contact's
// BranchID (derived from their stored peerId) and shows whatever route hints
// their most recent signed identity.announce publishes. An accepted record
// means a fresh signed source exists, not that they are online right now —
// this does not change which relay ChatPage actually sends through yet.
export function ContactRouteLookup({ peerId }: { readonly peerId: string }): React.JSX.Element | null {
  const branchID = useBranchID(peerId);
  const [status, setStatus] = useState<LookupStatus>("idle");
  const [routeHints, setRouteHints] = useState<readonly IdentityContactRouteHint[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  if (branchID === null) {
    return null;
  }

  const runLookup = (): void => {
    setStatus("pending");
    setMessage(null);
    lookupIdentityContactViaGitHub(branchID)
      .then((result) => {
        setMessage(result.message);
        if (result.accepted !== null) {
          setStatus("accepted");
          setRouteHints(result.accepted.routeHints);
          return;
        }
        setStatus("rejected");
        setRouteHints([]);
      })
      .catch((cause: unknown) => {
        setStatus("error");
        setMessage(cause instanceof Error ? cause.message : "route lookup failed");
      });
  };

  return (
    <div className="pwa-chat-detail pwa-route-lookup">
      <Button loading={status === "pending"} onClick={runLookup} size="small" type="text">
        Check published route ({branchID.slice(0, 12)}…)
      </Button>
      {status === "accepted" && (
        <span>
          {routeHints.length} route hint{routeHints.length === 1 ? "" : "s"} found
          {routeHints[0] !== undefined ? ` · ${routeHints[0].uri}` : ""}
        </span>
      )}
      {status === "rejected" && <span>No fresh public route announcement for this contact</span>}
      {status === "error" && message !== null && <span>{message}</span>}
    </div>
  );
}
