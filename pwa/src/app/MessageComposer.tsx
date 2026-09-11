import { CloseOutlined, SendOutlined } from "@ant-design/icons";
import { Button, Input, Space } from "antd";
import { useEffect, useRef, useState } from "react";
import { AttachmentSendControl } from "./AttachmentSendControl.js";
import { presentClipboardImage, presentDroppedImage } from "./image-message.js";
import type { ImageInput, ImageInputRejection } from "./image-message.js";

interface ComposerTextAreaRef {
  readonly focus: () => void;
  readonly blur: () => void;
}

export function MessageComposer({ value, onChange, onSend, onTyping, onImageInput, onImageRejected, onCancelReply, attachmentPeerId, placeholder, replyToMessageId }: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSend: () => void;
  readonly onTyping?: () => void;
  // The caller must hand the transient File directly to the local image
  // normalizer/transport boundary; MessageComposer never retains it.
  readonly onImageInput?: (input: ImageInput, caption: string) => void;
  readonly onImageRejected?: (reason: ImageInputRejection) => void;
  readonly attachmentPeerId?: string;
  readonly replyToMessageId?: string | null;
  readonly onCancelReply?: () => void;
  readonly placeholder: string;
}): React.JSX.Element {
  const pendingImage = useRef<ImageInput | null>(null);
  const textAreaRef = useRef<ComposerTextAreaRef | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (replyToMessageId === null || replyToMessageId === undefined) return;
    const frame = requestAnimationFrame(() => { textAreaRef.current?.focus(); });
    return () => { cancelAnimationFrame(frame); };
  }, [replyToMessageId]);
  const clearPendingImage = (): void => {
    if (previewUrl !== null) URL.revokeObjectURL(previewUrl);
    pendingImage.current = null;
    setPreviewUrl(null);
  };
  const stageImage = (input: ImageInput): void => {
    clearPendingImage();
    pendingImage.current = input;
    setPreviewUrl(URL.createObjectURL(input.file));
  };
  const submit = (): void => {
    const image = pendingImage.current;
    if (image !== null && onImageInput !== undefined) {
      clearPendingImage();
      onImageInput(image, value.trim());
      return;
    }
    onSend();
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }
    event.preventDefault();
    submit();
  };

  return (
    <>
      {replyToMessageId !== null && replyToMessageId !== undefined && <div className="pwa-reply-draft" role="status">
        <span>Replying to message</span>
        <Button aria-label="Cancel reply" icon={<CloseOutlined />} onClick={onCancelReply} size="small" type="text" />
      </div>}
      {previewUrl !== null && <div className="pwa-image-draft" role="group" aria-label="Image draft">
        <img alt="Image ready to send" src={previewUrl} />
        <Button aria-label="Cancel image" icon={<CloseOutlined />} onClick={clearPendingImage} type="text" />
      </div>}
      <Space.Compact className="pwa-chat-composer">
      {attachmentPeerId !== undefined && <AttachmentSendControl
        peerId={attachmentPeerId}
        {...(onImageInput === undefined ? {} : { onImageInput: stageImage })}
        {...(onImageRejected === undefined ? {} : { onImageRejected })}
      />}
      <Input.TextArea
        autoSize={{ minRows: 1, maxRows: 5 }}
        onChange={(event) => {
          onChange(event.currentTarget.value);
          if (event.currentTarget.value.trim() !== "") {
            onTyping?.();
          }
        }}
        onKeyDown={onKeyDown}
        onPaste={(event) => {
          if (onImageInput !== undefined) {
            presentClipboardImage(event, stageImage, onImageRejected);
          }
        }}
        onDragOver={(event) => {
          if (onImageInput !== undefined && event.dataTransfer.types.includes("Files")) {
            event.preventDefault();
          }
        }}
        onDrop={(event) => {
          if (onImageInput !== undefined) {
            presentDroppedImage(event, stageImage, onImageRejected);
          }
        }}
        placeholder={previewUrl === null ? placeholder : "Add a caption"}
        ref={textAreaRef}
        value={value}
      />
      <Button aria-label={previewUrl === null ? "Send message" : "Send image"} icon={<SendOutlined />} onClick={submit} type="primary" />
      </Space.Compact>
    </>
  );
}
