import { CheckOutlined, CloseOutlined, PaperClipOutlined } from "@ant-design/icons";
import { Button, Space, Typography } from "antd";

import type { InboundAttachmentOffer as InboundAttachmentOfferValue, InboundAttachmentOfferDecision } from "../state/slices/inbound-attachment-offers-slice.js";

/**
 * A manifest is an offer, not a received file. This component intentionally
 * renders no preview, download link, file input, or automatic action.
 */
export function InboundAttachmentOffer({ offer, onDecision }: {
  readonly offer: InboundAttachmentOfferValue | null;
  readonly onDecision: (decision: InboundAttachmentOfferDecision) => void;
}): React.JSX.Element | null {
  if (offer === null) {
    return null;
  }
  const responding = offer.responseState === "responding";
  return (
    <aside aria-label="Incoming file offer" className="pwa-inbound-attachment-offer">
      <div className="pwa-inbound-attachment-offer-heading">
        <PaperClipOutlined aria-hidden />
        <Typography.Text strong>Incoming file offer</Typography.Text>
      </div>
      <dl className="pwa-inbound-attachment-offer-metadata">
        <div><dt>File</dt><dd>{offer.fileName}</dd></div>
        <div><dt>Type</dt><dd>{offer.mediaType}</dd></div>
        <div><dt>Size</dt><dd>{formatByteCount(offer.byteCount)}</dd></div>
      </dl>
      <Typography.Text className="pwa-inbound-attachment-offer-note" type="secondary">
        No file is accepted or stored until you choose.
      </Typography.Text>
      {offer.responseError !== null && <Typography.Text className="pwa-inbound-attachment-offer-error" type="danger">{offer.responseError}</Typography.Text>}
      <Space className="pwa-inbound-attachment-offer-actions" wrap>
        <Button disabled={responding} icon={<CheckOutlined />} loading={responding} onClick={() => { onDecision("accept"); }} type="primary">Accept</Button>
        <Button disabled={responding} icon={<CloseOutlined />} onClick={() => { onDecision("reject"); }}>Reject</Button>
      </Space>
    </aside>
  );
}

export function formatByteCount(byteCount: number): string {
  if (byteCount < 1024) {
    return `${String(byteCount)} B`;
  }
  if (byteCount < 1024 * 1024) {
    return `${(byteCount / 1024).toFixed(1)} KiB`;
  }
  return `${(byteCount / (1024 * 1024)).toFixed(1)} MiB`;
}
