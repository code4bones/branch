import { CheckOutlined, ExclamationCircleOutlined, LoadingOutlined, RedoOutlined, SelectOutlined, VerticalAlignBottomOutlined } from "@ant-design/icons";
import { Button, Dropdown, Empty, Tooltip } from "antd";
import type { MenuProps } from "antd";
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { InlineImageMessageBubble } from "./image-message.js";
import type { LocalImageMessageProjection } from "./image-message.js";
import { loadLocalReplyImagePreview, resolveLocalReplyPreview, type ReplyPreview as ReplyPreviewModel } from "./reply-presentation.js";
import type { MessageDeliveryState, MessageSummary } from "../state/slices/conversations-slice.js";

const bottomThresholdPx = 48;

export function MessageLog({ contactId, messages, imageMessages = [], emptyDescription, hasOlder = false, loadingOlder = false, menuMessageId, selectedMessageIds, onCloseMessageMenu, onIncomingMessageAutoPresented, onLoadOlder, onLoadLatest, onLoadReplyTarget, onOpenMessageMenu, onReplyMessage, onRetryUnavailableMessage, onToggleMessageSelection }: {
  readonly contactId: string;
  readonly messages: readonly MessageSummary[];
  // Image projections contain only verified metadata and endpoint-owned Blob
  // URLs. Their bytes live behind the local media-storage boundary.
  readonly imageMessages?: readonly LocalImageMessageProjection[];
  readonly emptyDescription: string;
  readonly hasOlder?: boolean;
  readonly loadingOlder?: boolean;
  // All action state is supplied by the local UI slice; MessageLog never
  // stores or sends selection, deletion, or forwarding metadata itself.
  readonly menuMessageId?: string | null;
  readonly selectedMessageIds?: readonly string[];
  readonly onCloseMessageMenu?: () => void;
  readonly onLoadOlder?: () => Promise<void>;
  readonly onLoadLatest?: () => Promise<void>;
  readonly onLoadReplyTarget?: (applicationMessageId: string) => Promise<void>;
  // This reports only the newest incoming message that this log has actually
  // auto-scrolled into the active view. It intentionally does not fire for an
  // unread message while the reader has scrolled away from the bottom.
  readonly onIncomingMessageAutoPresented?: (message: MessageSummary) => void;
  readonly onOpenMessageMenu?: (message: MessageSummary) => void;
  readonly onReplyMessage?: (applicationMessageId: string) => void;
  readonly onRetryUnavailableMessage?: (message: MessageSummary) => void;
  readonly onToggleMessageSelection?: (message: MessageSummary) => void;
}): React.JSX.Element {
  const logRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const loadingOlderRef = useRef(false);
  const pendingReplyTarget = useRef<string | null>(null);
  const stickToBottom = useRef(true);
  const previous = useRef<{ readonly contactId: string | null; readonly count: number; readonly newestId: string | null }>({
    contactId: null,
    count: 0,
    newestId: null
  });
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const timeline = mergeChatTimeline(messages, imageMessages);
  const newestTimelineEntry = timeline.at(-1) ?? null;
  const newest = newestTimelineEntry?.kind === "text" ? newestTimelineEntry.message : null;
  const newestTimelineMessageId = newestTimelineEntry?.messageId ?? null;
  const newestTimelineDirection = imageMessageDirection(newestTimelineEntry);
  const selectionActive = (selectedMessageIds?.length ?? 0) > 0;
  const scrollToReplyTarget = useCallback((applicationMessageId: string): boolean => {
    const node = logRef.current;
    if (node === null) return false;
    const target = Array.from(node.querySelectorAll<HTMLElement>("[data-application-message-id]")).find((candidate) => candidate.dataset.applicationMessageId === applicationMessageId);
    if (target === undefined) return false;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.remove("is-reply-target");
    void target.offsetWidth;
    target.classList.add("is-reply-target");
    window.setTimeout(() => { target.classList.remove("is-reply-target"); }, 1_400);
    return true;
  }, []);
  const jumpToReplyTarget = useCallback((applicationMessageId: string): void => {
    if (scrollToReplyTarget(applicationMessageId) || onLoadReplyTarget === undefined) return;
    pendingReplyTarget.current = applicationMessageId;
    void onLoadReplyTarget(applicationMessageId).catch(() => {
      if (pendingReplyTarget.current === applicationMessageId) pendingReplyTarget.current = null;
    });
  }, [onLoadReplyTarget, scrollToReplyTarget]);

  const scrollToLatest = useCallback((): void => {
    const node = logRef.current;
    if (node === null) {
      return;
    }
    node.scrollTop = node.scrollHeight;
    stickToBottom.current = true;
    setShowScrollToBottom(false);
  }, []);
  const loadLatestAndScroll = useCallback((): void => {
    if (onLoadLatest === undefined) {
      scrollToLatest();
      return;
    }
    void onLoadLatest().finally(() => {
      requestAnimationFrame(scrollToLatest);
    });
  }, [onLoadLatest, scrollToLatest]);

  const onScroll = useCallback((): void => {
    const node = logRef.current;
    if (node === null) {
      return;
    }
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight <= bottomThresholdPx;
    stickToBottom.current = atBottom;
    setShowScrollToBottom(!atBottom);
  }, []);

  const loadOlderPreservingAnchor = useCallback((): void => {
    const node = logRef.current;
    if (node === null || !hasOlder || loadingOlderRef.current || onLoadOlder === undefined) return;
    const previousHeight = node.scrollHeight;
    const previousTop = node.scrollTop;
    loadingOlderRef.current = true;
    void onLoadOlder().finally(() => {
      requestAnimationFrame(() => {
        const current = logRef.current;
        if (current !== null) current.scrollTop = previousTop + current.scrollHeight - previousHeight;
        loadingOlderRef.current = false;
      });
    });
  }, [hasOlder, onLoadOlder]);

  useEffect(() => {
    const target = topSentinelRef.current;
    if (target === null || !hasOlder || loadingOlder || onLoadOlder === undefined || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadOlderPreservingAnchor();
    }, { root: logRef.current, rootMargin: "360px 0px 0px 0px", threshold: 0 });
    observer.observe(target);
    return () => { observer.disconnect(); };
  }, [hasOlder, loadOlderPreservingAnchor, loadingOlder, onLoadOlder]);

  useLayoutEffect(() => {
    const was = previous.current;
    const openedDifferentConversation = was.contactId !== contactId;
    const receivedNewMessage = !openedDifferentConversation && (
      timeline.length > was.count || newestTimelineMessageId !== was.newestId
    );

    const autoPresentedIncoming = autoPresentedIncomingMessage({
      newest,
      previousNewestId: was.newestId,
      openedDifferentConversation,
      wasAtBottom: stickToBottom.current
    });
    if (openedDifferentConversation || stickToBottom.current || newestTimelineDirection === "outgoing") {
      scrollToLatest();
      if (autoPresentedIncoming !== null) {
        onIncomingMessageAutoPresented?.(autoPresentedIncoming);
      }
    } else if (receivedNewMessage) {
      setShowScrollToBottom(true);
    }

    previous.current = { contactId, count: timeline.length, newestId: newestTimelineMessageId };
  }, [contactId, newest, newestTimelineDirection, newestTimelineMessageId, onIncomingMessageAutoPresented, scrollToLatest, timeline.length]);

  useLayoutEffect(() => {
    const pending = pendingReplyTarget.current;
    if (pending !== null && scrollToReplyTarget(pending)) pendingReplyTarget.current = null;
  }, [scrollToReplyTarget, timeline]);

  return (
    <div className="pwa-chat-log-container">
      <div aria-label="Message log" aria-live="polite" className="pwa-chat-log" onScroll={onScroll} ref={logRef} role="log">
        <div aria-hidden="true" ref={topSentinelRef} />
        {messages.length === 0 && imageMessages.length === 0 ? (
          <Empty description={emptyDescription} />
        ) : (
          timeline.map((entry, index, entries) => (
            <Fragment key={entry.messageId}>
              {startsNewTimelineDay(entries[index - 1] ?? null, entry) && <ChatDayDivider timestamp={entry.sentAt} />}
              {entry.kind === "text" ? (
                <ChatBubble
                  message={entry.message}
                  menuOpen={menuMessageId === entry.message.messageId}
                  selectionActive={selectionActive}
                  selected={selectedMessageIds?.includes(entry.message.messageId) ?? false}
                  {...(onCloseMessageMenu === undefined ? {} : { onCloseMenu: onCloseMessageMenu })}
                  {...(onOpenMessageMenu === undefined ? {} : { onOpenMenu: () => { onOpenMessageMenu(entry.message); } })}
                  {...(onReplyMessage === undefined ? {} : { onReply: onReplyMessage })}
                  {...(entry.message.replyToMessageId === undefined ? {} : { replyPreview: <ReplyPreview reply={resolveLocalReplyPreview(entry.message.replyToMessageId, messages, imageMessages)} onJump={() => { if (entry.message.replyToMessageId !== undefined) jumpToReplyTarget(entry.message.replyToMessageId); }} /> })}
                  {...(onRetryUnavailableMessage === undefined ? {} : { onRetryUnavailableMessage })}
                  {...(onToggleMessageSelection === undefined ? {} : { onToggleSelection: () => { onToggleMessageSelection(entry.message); } })}
                />
              ) : (
                <Dropdown
                  menu={{ items: onReplyMessage === undefined ? [] : [{ key: "reply", label: "Reply" }], onClick: ({ key }) => { if (key === "reply") onReplyMessage?.(entry.image.messageId); } }}
                  trigger={onReplyMessage === undefined ? [] : ["contextMenu"]}
                >
                  <div className={`pwa-chat-image-trigger is-${entry.image.direction}`}>
                    <InlineImageMessageBubble
                      image={entry.image}
                      footer={entry.image.direction === "outgoing" && entry.image.deliveryState !== undefined ? <DeliveryStateIcon state={entry.image.deliveryState} /> : undefined}
                      {...(entry.image.replyToMessageId === undefined ? {} : { replyPreview: <ReplyPreview reply={resolveLocalReplyPreview(entry.image.replyToMessageId, messages, imageMessages)} onJump={() => { if (entry.image.replyToMessageId !== undefined) jumpToReplyTarget(entry.image.replyToMessageId); }} /> })}
                    />
                  </div>
                </Dropdown>
              )}
            </Fragment>
          ))
        )}
      </div>
      <Tooltip title="Scroll to bottom">
        <Button
          aria-hidden={!showScrollToBottom}
          aria-label="Scroll to bottom"
          className={`pwa-chat-latest-button${showScrollToBottom ? " is-visible" : ""}`}
          icon={<VerticalAlignBottomOutlined />}
          onClick={loadLatestAndScroll}
          shape="circle"
          size="middle"
          tabIndex={showScrollToBottom ? 0 : -1}
          type="primary"
        />
      </Tooltip>
    </div>
  );
}

type ChatTimelineEntry =
  | { readonly kind: "text"; readonly message: MessageSummary; readonly messageId: string; readonly sentAt: number }
  | { readonly kind: "image"; readonly image: LocalImageMessageProjection; readonly messageId: string; readonly sentAt: number };

export function mergeChatTimeline(messages: readonly MessageSummary[], imageMessages: readonly LocalImageMessageProjection[]): readonly ChatTimelineEntry[] {
  return [
    ...messages.map((message): ChatTimelineEntry => ({ kind: "text", message, messageId: message.messageId, sentAt: message.sentAt })),
    ...imageMessages.map((image): ChatTimelineEntry => ({ kind: "image", image, messageId: image.messageId, sentAt: image.sentAt }))
  ].sort((left, right) => left.sentAt - right.sentAt || left.messageId.localeCompare(right.messageId));
}

function startsNewTimelineDay(previous: ChatTimelineEntry | null, current: ChatTimelineEntry): boolean {
  return previous === null || localDayKey(previous.sentAt) !== localDayKey(current.sentAt);
}

function imageMessageDirection(entry: ChatTimelineEntry | null): "incoming" | "outgoing" | "service" | null {
  if (entry === null) return null;
  return entry.kind === "text" ? entry.message.direction : entry.image.direction;
}

export function autoPresentedIncomingMessage(options: {
  readonly newest: MessageSummary | null;
  readonly previousNewestId: string | null;
  readonly openedDifferentConversation: boolean;
  readonly wasAtBottom: boolean;
}): MessageSummary | null {
  if (options.newest === null || options.newest.direction !== "incoming") {
    return null;
  }
  // Changing conversations is an explicit new presentation of this chat. Do
  // not compare against a stale prior-log ID here: a valid read receipt for
  // the selected incoming message is still deduplicated by its control path.
  if (options.openedDifferentConversation) {
    return options.newest;
  }
  if (options.newest.messageId === options.previousNewestId) {
    return null;
  }
  return options.wasAtBottom ? options.newest : null;
}

function ChatBubble({ menuOpen, message, onCloseMenu, onOpenMenu, onReply, onRetryUnavailableMessage, onToggleSelection, replyPreview, selected, selectionActive }: {
  readonly message: MessageSummary;
  readonly menuOpen: boolean;
  readonly selected: boolean;
  readonly selectionActive: boolean;
  readonly onCloseMenu?: () => void;
  readonly onOpenMenu?: () => void;
  readonly onReply?: (applicationMessageId: string) => void;
  readonly onRetryUnavailableMessage?: (message: MessageSummary) => void;
  readonly onToggleSelection?: () => void;
  readonly replyPreview?: React.ReactNode;
}): React.JSX.Element {
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressNextClick = useRef(false);
  const suppressNextContextMenu = useRef(false);
  const hasMessageActions = onToggleSelection !== undefined || (onReply !== undefined && message.applicationMessageId !== undefined);
  const messageActions: MenuProps = {
    items: [
      ...(onReply === undefined || message.applicationMessageId === undefined ? [] : [{ key: "reply", label: "Reply" }]),
      ...(onToggleSelection === undefined ? [] : [{ key: "select", icon: <SelectOutlined />, label: selected ? "Unselect message" : "Select message" }])
    ],
    onClick: ({ key }) => {
      if (key === "reply" && message.applicationMessageId !== undefined) onReply?.(message.applicationMessageId);
      if (key === "select") onToggleSelection?.();
    }
  };
  const clearLongPress = (): void => {
    if (longPressTimer.current !== null) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };
  const onPointerDown = (event: React.PointerEvent<HTMLElement>): void => {
    if (event.pointerType !== "touch" || onToggleSelection === undefined) return;
    clearLongPress();
    longPressTimer.current = setTimeout(() => {
      longPressTimer.current = null;
      suppressNextClick.current = true;
      suppressNextContextMenu.current = true;
      onToggleSelection();
    }, longPressDurationMs);
  };
  const onBubbleClick = (): void => {
    if (suppressNextClick.current) {
      suppressNextClick.current = false;
      return;
    }
    if (selectionActive) onToggleSelection?.();
  };
  return (
    <Dropdown menu={messageActions} onOpenChange={(open) => {
      if (!open) {
        onCloseMenu?.();
      } else if (suppressNextContextMenu.current) {
        suppressNextContextMenu.current = false;
        onCloseMenu?.();
      } else {
        onOpenMenu?.();
      }
    }} open={hasMessageActions ? menuOpen : false} trigger={hasMessageActions ? ["contextMenu"] : []}>
      <article
        className={`pwa-chat-message is-${message.direction}${selected ? " is-selected" : ""}`}
        {...(message.applicationMessageId === undefined ? {} : { "data-application-message-id": message.applicationMessageId })}
        onClick={onBubbleClick}
        onPointerCancel={clearLongPress}
        onPointerDown={onPointerDown}
        onPointerLeave={clearLongPress}
        onPointerUp={clearLongPress}
      >
        {replyPreview}
        <span className="pwa-chat-message-body">{message.body}</span>
        <footer className="pwa-chat-message-meta">
          <time dateTime={new Date(message.sentAt).toISOString()}>{formatMessageTime(message.sentAt)}</time>
          {message.direction === "outgoing" && <DeliveryStateIcon state={message.deliveryState} />}
          {message.direction === "outgoing" && message.deliveryState === "unavailable" && onRetryUnavailableMessage !== undefined && (
            <Tooltip title="Retry sending message">
              <Button aria-label="Retry sending message" className="pwa-chat-retry-message" icon={<RedoOutlined />} onClick={() => { onRetryUnavailableMessage(message); }} size="small" type="text" />
            </Tooltip>
          )}
        </footer>
      </article>
    </Dropdown>
  );
}

function ReplyPreview({ onJump, reply }: { readonly onJump?: () => void; readonly reply: ReplyPreviewModel }): React.JSX.Element {
  const [loadedImageUrl, setLoadedImageUrl] = useState<string | null>(null);
  useEffect(() => {
    if (reply.kind !== "image" || reply.objectUrl !== null || reply.loadObjectUrl === undefined) {
      setLoadedImageUrl(null);
      return;
    }
    let disposed = false;
    let createdUrl: string | null = null;
    void loadLocalReplyImagePreview(reply).then((url) => {
      if (disposed) {
        if (url !== null) URL.revokeObjectURL(url);
        return;
      }
      createdUrl = url;
      setLoadedImageUrl(url);
    }).catch(() => { if (!disposed) setLoadedImageUrl(null); });
    return () => {
      disposed = true;
      if (createdUrl !== null) URL.revokeObjectURL(createdUrl);
    };
  }, [reply]);
  const imageUrl = reply.kind === "image" ? reply.objectUrl ?? loadedImageUrl : null;
  const content = reply.kind === "text"
    ? <span>{reply.body}</span>
    : reply.kind === "image"
      ? <>{imageUrl === null ? <span>Image unavailable</span> : <img alt="Replied image" src={imageUrl} />}{reply.caption !== undefined && <span>{reply.caption}</span>}</>
      : <span>Original message unavailable</span>;
  return onJump === undefined
    ? <div className="pwa-chat-reply-preview">{content}</div>
    : <button className="pwa-chat-reply-preview" onClick={(event) => { event.stopPropagation(); onJump(); }} type="button">{content}</button>;
}

const longPressDurationMs = 550;

function ChatDayDivider({ timestamp }: { readonly timestamp: number }): React.JSX.Element {
  return <div className="pwa-chat-day-divider">{formatMessageDay(timestamp)}</div>;
}

function localDayKey(timestamp: number): string {
  const date = new Date(timestamp);
  return [date.getFullYear(), date.getMonth(), date.getDate()].map(String).join("-");
}

function formatMessageTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

function formatMessageDay(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  if (localDayKey(timestamp) === localDayKey(today.getTime())) {
    return "Today";
  }
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (localDayKey(timestamp) === localDayKey(yesterday.getTime())) {
    return "Yesterday";
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function DeliveryStateIcon({ state }: { readonly state: MessageDeliveryState }): React.JSX.Element {
  const presentation = deliveryStatePresentation(state);
  return (
    <Tooltip title={presentation.label}>
      <span aria-label={presentation.label} className={`pwa-chat-delivery-status is-${state}`} role="img">
        {deliveryStateIcon(presentation.mark, state)}
      </span>
    </Tooltip>
  );
}

export function deliveryStatePresentation(state: MessageDeliveryState): { readonly label: string; readonly mark: "pending" | "single-check" | "double-check" | "unavailable" } {
  switch (state) {
    case "pending":
      return { label: "Sending", mark: "pending" };
    case "relayed":
      return { label: "Sent", mark: "single-check" };
    case "delivered":
      return { label: "Delivered to recipient", mark: "double-check" };
    case "read":
      return { label: "Read by recipient", mark: "double-check" };
    case "received":
      return { label: "Received (legacy)", mark: "double-check" };
    case "unavailable":
      return { label: "Unavailable", mark: "unavailable" };
  }
}

function deliveryStateIcon(mark: ReturnType<typeof deliveryStatePresentation>["mark"], state: MessageDeliveryState): React.JSX.Element {
  switch (mark) {
    case "pending": return <LoadingOutlined spin />;
    case "single-check": return <CheckOutlined className={`pwa-chat-delivery-check is-${state}`} />;
    case "double-check": return <DoubleCheckIcon state={state} />;
    case "unavailable": return <ExclamationCircleOutlined />;
  }
}

function DoubleCheckIcon({ state }: { readonly state: MessageDeliveryState }): React.JSX.Element {
  return (
    <span aria-hidden="true" className="pwa-chat-delivery-double-check">
      <CheckOutlined className={`pwa-chat-delivery-check is-${state}`} />
      <CheckOutlined className={`pwa-chat-delivery-check is-${state}`} />
    </span>
  );
}
