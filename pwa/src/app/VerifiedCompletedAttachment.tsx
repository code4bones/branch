import { DownloadOutlined, PaperClipOutlined, SafetyCertificateOutlined } from "@ant-design/icons";
import { Button, Typography } from "antd";

import { formatByteCount } from "./InboundAttachmentOffer.js";
import type { CompletedAttachment } from "../state/slices/completed-attachments-slice.js";

/** Displays metadata from a whole-file SHA-256-verified, volatile handle. */
export function VerifiedCompletedAttachment({ attachment, onDownload }: {
  readonly attachment: CompletedAttachment | null;
  readonly onDownload: () => void;
}): React.JSX.Element | null {
  if (attachment === null) {
    return null;
  }
  return (
    <aside aria-label="Verified received file" className="pwa-verified-completed-attachment">
      <div className="pwa-verified-completed-attachment-heading">
        <PaperClipOutlined aria-hidden />
        <Typography.Text strong>Verified received file</Typography.Text>
        <SafetyCertificateOutlined aria-label="Integrity verified" />
      </div>
      <dl className="pwa-verified-completed-attachment-metadata">
        <div><dt>File</dt><dd>{attachment.fileName}</dd></div>
        <div><dt>Type</dt><dd>{attachment.mediaType}</dd></div>
        <div><dt>Size</dt><dd>{formatByteCount(attachment.byteCount)}</dd></div>
      </dl>
      <Typography.Text className="pwa-verified-completed-attachment-note" type="secondary">
        Kept only in this live tab until it expires. Download does not upload or store it in B.R.A.N.C.H.
      </Typography.Text>
      <Button icon={<DownloadOutlined />} onClick={onDownload} type="primary">Download</Button>
    </aside>
  );
}
