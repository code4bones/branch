import { PaperClipOutlined } from "@ant-design/icons";
import { Button, Typography } from "antd";
import { useEffect, useRef, useState } from "react";

import { attachmentSendAdmission, offerSelectedAttachment, subscribeAttachmentSendProgress } from "./attachment-send-bridge.js";
import { useAppStoreApi } from "../state/StoreProvider.js";

/** Explicit one-file picker. It never keeps the selected File in React state. */
export function AttachmentSendControl({ peerId }: { readonly peerId: string }): React.JSX.Element {
  const storeApi = useAppStoreApi();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [offering, setOffering] = useState(false);

  useEffect(() => subscribeAttachmentSendProgress(storeApi, (event) => {
    if (event.peerId !== peerId || event.direction !== "outbound") return;
    const next = transferNotice(event);
    if (next !== null) setNotice(next);
  }), [peerId, storeApi]);

  const selectFile = (): void => {
    const admission = attachmentSendAdmission(storeApi, peerId);
    if (admission.status !== "ready") {
      setNotice(admissionNotice(admission.status));
      return;
    }
    setNotice(null);
    inputRef.current?.click();
  };

  const offerFile = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const files = event.currentTarget.files;
    const file = files?.item(0) ?? null;
    // `multiple` is absent by design. Keep the defensive branch in case a
    // browser extension or synthetic event supplies more than one file.
    if (file === null || files === null || files.length !== 1) {
      event.currentTarget.value = "";
      setNotice("Choose one file for this live transfer.");
      return;
    }
    setOffering(true);
    setNotice(null);
    void offerSelectedAttachment(storeApi, peerId, file).then((result) => {
      setNotice(result.status === "offered" ? "File offer sent. Waiting for the recipient to accept." : rejectionNotice(result.reason));
    }).catch(() => {
      setNotice("The live file offer could not be sent.");
    }).finally(() => {
      // The controller owns the File reference after this call. Clearing the
      // input permits intentionally choosing the same file again later.
      event.currentTarget.value = "";
      setOffering(false);
    });
  };

  return (
    <div className="pwa-attachment-send-control">
      <input
        aria-label="Choose a file to send"
        className="pwa-attachment-file-input"
        onChange={offerFile}
        ref={inputRef}
        type="file"
      />
      <Button aria-label="Send file" disabled={offering} icon={<PaperClipOutlined />} loading={offering} onClick={selectFile} type="text">
        File
      </Button>
      {notice !== null && <Typography.Text aria-live="polite" className="pwa-attachment-send-notice" type="secondary">{notice}</Typography.Text>}
    </div>
  );
}

function admissionNotice(reason: "unavailable" | "unsupported" | "busy"): string {
  switch (reason) {
    case "unsupported": return "This contact is not currently accepting live file transfers.";
    case "busy": return "A live file transfer is already active for this contact.";
    case "unavailable": return "File transfer needs a reachable contact and an attached live relay.";
  }
}

function rejectionNotice(reason: "unknown_peer" | "unsupported" | "busy" | "unavailable" | "send_failed"): string {
  switch (reason) {
    case "unknown_peer": return "Files can be sent only to an existing contact.";
    case "unsupported": return "This file exceeds the current live-transfer capability or is not supported.";
    case "busy": return "A live file transfer is already active for this contact.";
    case "unavailable": return "The contact or live relay is no longer available.";
    case "send_failed": return "The live file offer could not be sent.";
  }
}

function transferNotice(event: { readonly event: string; readonly reason: string }): string | null {
  if (event.event === "attachment.offer.sent") return "File offer sent. Waiting for the recipient to accept.";
  if (event.event === "attachment.transfer.accepted") return "Recipient accepted. Sending file chunks…";
  if (event.event !== "attachment.transfer.ended") return null;
  switch (event.reason) {
    case "accepted": return "Recipient accepted; all file chunks were forwarded.";
    case "rejected": return "Recipient declined the file offer.";
    case "expired": return "File offer expired before transfer completed.";
    case "ack_timeout": return "File transfer ended: relay forwarding timed out.";
    case "disconnected": return "File transfer ended: relay disconnected.";
    case "unavailable": return "File transfer ended: contact or relay unavailable.";
    default: return "File transfer ended before completion.";
  }
}
