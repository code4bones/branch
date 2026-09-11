import { FileOutlined, PaperClipOutlined, PictureOutlined } from "@ant-design/icons";
import { Button, Dropdown, Typography } from "antd";
import type { MenuProps } from "antd";
import { useEffect, useRef, useState } from "react";

import { attachmentSendAdmission, offerSelectedAttachment, subscribeAttachmentSendProgress } from "./attachment-send-bridge.js";
import { acceptedImageMediaTypes, imageInputFromFiles } from "./image-message.js";
import type { ImageInput, ImageInputRejection } from "./image-message.js";
import { useAppStoreApi } from "../state/StoreProvider.js";

/** Explicit one-file picker. It never keeps the selected File in React state. */
export function AttachmentSendControl({ peerId, onImageInput, onImageRejected }: {
  readonly peerId: string;
  readonly onImageInput?: (input: ImageInput) => void;
  readonly onImageRejected?: (reason: ImageInputRejection) => void;
}): React.JSX.Element {
  const storeApi = useAppStoreApi();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [offering, setOffering] = useState(false);

  useEffect(() => subscribeAttachmentSendProgress(storeApi, (event) => {
    if (event.peerId !== peerId || event.direction !== "outbound") return;
    if (event.event === "attachment.transfer.ended" && event.reason === "accepted") {
      setNotice(null);
      return;
    }
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
    // React may clear currentTarget after this synchronous handler returns;
    // retain the real input before hashing/signing the selected File.
    const input = event.currentTarget;
    const files = input.files;
    const file = files?.item(0) ?? null;
    // `multiple` is absent by design. Keep the defensive branch in case a
    // browser extension or synthetic event supplies more than one file.
    if (file === null || files === null || files.length !== 1) {
      input.value = "";
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
      input.value = "";
      setOffering(false);
    });
  };

  const selectImage = (): void => { imageInputRef.current?.click(); };
  const stageImage = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const input = event.currentTarget;
    const image = imageInputFromFiles(input.files ?? [], "picker");
    input.value = "";
    if (image === null) {
      onImageRejected?.("no_image");
      return;
    }
    onImageInput?.(image);
  };
  const attachmentMenu: MenuProps = {
    items: [
      { key: "file", icon: <FileOutlined />, label: "Send file" },
      ...(onImageInput === undefined ? [] : [{ key: "image", icon: <PictureOutlined />, label: "Send image" }])
    ],
    onClick: ({ key }) => {
      if (key === "file") selectFile();
      if (key === "image") selectImage();
    }
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
      {onImageInput !== undefined && <input
        accept={acceptedImageMediaTypes.join(",")}
        aria-label="Choose an image to send"
        className="pwa-attachment-file-input"
        onChange={stageImage}
        ref={imageInputRef}
        type="file"
      />}
      <Dropdown menu={attachmentMenu} trigger={["click"]}>
        <Button aria-label="Add attachment" disabled={offering} icon={<PaperClipOutlined />} loading={offering} shape="circle" type="text" />
      </Dropdown>
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
