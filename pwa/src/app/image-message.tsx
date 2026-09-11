import { CloseOutlined } from "@ant-design/icons";
import { Button, Modal } from "antd";
import { useEffect, useRef, useState } from "react";

import type { MessageDeliveryState } from "../state/slices/conversations-slice.js";

export const acceptedImageMediaTypes = ["image/jpeg", "image/png", "image/webp"] as const;

export type AcceptedImageMediaType = typeof acceptedImageMediaTypes[number];
export type ImageInputSource = "clipboard" | "picker" | "drop";
export type ImageInputRejection = "no_image" | "unsupported_type";

// A File is deliberately kept only in the browser event/callback hand-off.
// Components and UI state must never retain image bytes.
export interface ImageInput {
  readonly file: File;
  readonly source: ImageInputSource;
}

export interface LocalImageMessageProjection {
  readonly messageId: string;
  readonly direction: "incoming" | "outgoing";
  readonly sentAt: number;
  readonly deliveryState?: MessageDeliveryState;
  // This is an endpoint-created Blob URL, never a remote image address. It is
  // absent until the bubble enters the bounded local viewport overscan.
  readonly objectUrl?: string;
  readonly loadObjectUrl?: () => Promise<string | null>;
  readonly mediaType: AcceptedImageMediaType;
  /** Verified dimensions reserve the bubble's media area before image decode. */
  readonly width: number;
  readonly height: number;
  readonly caption?: string;
  readonly replyToMessageId?: string;
  // The storage/presentation owner revokes its Blob URL when this projection
  // leaves the log. The UI never owns byte storage or fetches media itself.
  readonly onObjectUrlReleased?: (objectUrl: string) => void;
}

export function isAcceptedImageMediaType(value: string): value is AcceptedImageMediaType {
  return acceptedImageMediaTypes.some((mediaType) => mediaType === value.toLowerCase());
}

export function acceptedImageFromFiles(files: ArrayLike<File>): File | null {
  for (const file of Array.from(files)) {
    if (isAcceptedImageMediaType(file.type)) {
      return file;
    }
  }
  return null;
}

export function imageInputFromFiles(files: ArrayLike<File>, source: ImageInputSource): ImageInput | null {
  const file = acceptedImageFromFiles(files);
  return file === null ? null : { file, source };
}

export function isLocalImageObjectUrl(value: string): boolean {
  return value.startsWith("blob:");
}

export function presentClipboardImage(event: React.ClipboardEvent<HTMLTextAreaElement>, onImageInput: (input: ImageInput) => void, onImageRejected?: (reason: ImageInputRejection) => void): boolean {
  const files = event.clipboardData.files;
  if (files.length === 0) {
    return false;
  }
  const imageInput = imageInputFromFiles(files, "clipboard");
  if (imageInput === null) {
    event.preventDefault();
    onImageRejected?.("unsupported_type");
    return true;
  }
  event.preventDefault();
  onImageInput(imageInput);
  return true;
}

export function presentDroppedImage(event: React.DragEvent<HTMLTextAreaElement>, onImageInput: (input: ImageInput) => void, onImageRejected?: (reason: ImageInputRejection) => void): boolean {
  const files = event.dataTransfer.files;
  if (files.length === 0) {
    return false;
  }
  const imageInput = imageInputFromFiles(files, "drop");
  event.preventDefault();
  if (imageInput === null) {
    onImageRejected?.("unsupported_type");
    return true;
  }
  onImageInput(imageInput);
  return true;
}

export function InlineImageMessageBubble({ image, footer, replyPreview }: {
  readonly image: LocalImageMessageProjection;
  readonly footer?: React.ReactNode;
  readonly replyPreview?: React.ReactNode;
}): React.JSX.Element {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [objectUrl, setObjectUrl] = useState<string | null>(image.objectUrl ?? null);
  const imageRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (image.objectUrl !== undefined) {
      setObjectUrl(image.objectUrl);
      return;
    }
    const target = imageRef.current;
    if (target === null || image.loadObjectUrl === undefined || typeof IntersectionObserver === "undefined") return;
    let disposed = false;
    let createdUrl: string | null = null;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void image.loadObjectUrl?.().then((url) => {
        if (url === null || disposed) {
          if (url !== null) URL.revokeObjectURL(url);
          return;
        }
        createdUrl = url;
        setObjectUrl(url);
      });
    }, { rootMargin: "480px 0px", threshold: 0 });
    observer.observe(target);
    return () => {
      disposed = true;
      observer.disconnect();
      if (createdUrl !== null) {
        image.onObjectUrlReleased?.(createdUrl);
        URL.revokeObjectURL(createdUrl);
      }
    };
  }, [image.loadObjectUrl, image.objectUrl, image.onObjectUrlReleased]);

  const hasLocalObjectUrl = objectUrl !== null && isLocalImageObjectUrl(objectUrl);

  return (
    <article className={`pwa-chat-message pwa-chat-image-message is-${image.direction}`} data-application-message-id={image.messageId} data-message-id={image.messageId} ref={imageRef}>
      {replyPreview}
      {hasLocalObjectUrl ? (
        <button aria-label="Open shared image" className="pwa-chat-image-open" onClick={() => { setPreviewOpen(true); }} type="button">
          <img
            alt="Shared image"
            className="pwa-chat-image"
            decoding="async"
            height={image.height}
            src={objectUrl}
            width={image.width}
          />
        </button>
      ) : (
        <p className="pwa-chat-image-unavailable" role="status">Image is unavailable on this device.</p>
      )}
      {image.caption !== undefined && <p className="pwa-chat-image-caption">{image.caption}</p>}
      <footer className="pwa-chat-message-meta">
        <time dateTime={new Date(image.sentAt).toISOString()}>{formatImageMessageTime(image.sentAt)}</time>
        {footer}
      </footer>
      {hasLocalObjectUrl && <Modal
        className="pwa-image-preview-modal"
        closable={false}
        footer={null}
        onCancel={() => { setPreviewOpen(false); }}
        open={previewOpen}
        title={null}
        width="min(96vw, 1400px)"
      >
        <div className="pwa-image-preview-content">
          <div className="pwa-image-preview-toolbar">
            <span className="pwa-image-preview-title">Shared image</span>
            <Button aria-label="Close image preview" className="pwa-image-preview-close" icon={<CloseOutlined />} onClick={() => { setPreviewOpen(false); }} shape="circle" type="text" />
          </div>
          <img alt="Shared image" className="pwa-image-preview-full" src={objectUrl} />
        </div>
      </Modal>}
    </article>
  );
}

function formatImageMessageTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}
