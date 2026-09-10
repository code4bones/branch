import { CheckOutlined, ExclamationCircleOutlined, LoadingOutlined, RedoOutlined, SelectOutlined, VerticalAlignBottomOutlined } from "@ant-design/icons";
import { Button, Dropdown, Empty, Tooltip } from "antd";
import type { MenuProps } from "antd";
import { Fragment, useCallback, useLayoutEffect, useRef, useState } from "react";

import type { MessageDeliveryState, MessageSummary } from "../state/slices/conversations-slice.js";

const bottomThresholdPx = 48;

export function MessageLog({ contactId, messages, emptyDescription, menuMessageId, selectedMessageIds, onCloseMessageMenu, onIncomingMessageAutoPresented, onOpenMessageMenu, onRetryUnavailableMessage, onToggleMessageSelection }: {
  readonly contactId: string;
  readonly messages: readonly MessageSummary[];
  readonly emptyDescription: string;
  // All action state is supplied by the local UI slice; MessageLog never
  // stores or sends selection, deletion, or forwarding metadata itself.
  readonly menuMessageId?: string | null;
  readonly selectedMessageIds?: readonly string[];
  readonly onCloseMessageMenu?: () => void;
  // This reports only the newest incoming message that this log has actually
  // auto-scrolled into the active view. It intentionally does not fire for an
  // unread message while the reader has scrolled away from the bottom.
  readonly onIncomingMessageAutoPresented?: (message: MessageSummary) => void;
  readonly onOpenMessageMenu?: (message: MessageSummary) => void;
  readonly onRetryUnavailableMessage?: (message: MessageSummary) => void;
  readonly onToggleMessageSelection?: (message: MessageSummary) => void;
}): React.JSX.Element {
  const logRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const previous = useRef<{ readonly contactId: string | null; readonly count: number; readonly newestId: string | null }>({
    contactId: null,
    count: 0,
    newestId: null
  });
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const newest = messages.at(-1) ?? null;
  const selectionActive = (selectedMessageIds?.length ?? 0) > 0;

  const scrollToLatest = useCallback((): void => {
    const node = logRef.current;
    if (node === null) {
      return;
    }
    node.scrollTop = node.scrollHeight;
    stickToBottom.current = true;
    setShowScrollToBottom(false);
  }, []);

  const onScroll = useCallback((): void => {
    const node = logRef.current;
    if (node === null) {
      return;
    }
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight <= bottomThresholdPx;
    stickToBottom.current = atBottom;
    setShowScrollToBottom(!atBottom);
  }, []);

  useLayoutEffect(() => {
    const was = previous.current;
    const openedDifferentConversation = was.contactId !== contactId;
    const receivedNewMessage = !openedDifferentConversation && (
      messages.length > was.count || newest?.messageId !== was.newestId
    );

    const autoPresentedIncoming = autoPresentedIncomingMessage({
      newest,
      previousNewestId: was.newestId,
      openedDifferentConversation,
      wasAtBottom: stickToBottom.current
    });
    if (openedDifferentConversation || stickToBottom.current || newest?.direction === "outgoing") {
      scrollToLatest();
      if (autoPresentedIncoming !== null) {
        onIncomingMessageAutoPresented?.(autoPresentedIncoming);
      }
    } else if (receivedNewMessage) {
      setShowScrollToBottom(true);
    }

    previous.current = { contactId, count: messages.length, newestId: newest?.messageId ?? null };
  }, [contactId, messages.length, newest, onIncomingMessageAutoPresented, scrollToLatest]);

  return (
    <div className="pwa-chat-log-container">
      <div aria-label="Message log" aria-live="polite" className="pwa-chat-log" onScroll={onScroll} ref={logRef} role="log">
        {messages.length === 0 ? (
          <Empty description={emptyDescription} />
        ) : (
          messages.map((message, index) => (
            <Fragment key={message.messageId}>
              {startsNewDay(messages[index - 1] ?? null, message) && <ChatDayDivider timestamp={message.sentAt} />}
              <ChatBubble
                message={message}
                menuOpen={menuMessageId === message.messageId}
                selectionActive={selectionActive}
                selected={selectedMessageIds?.includes(message.messageId) ?? false}
                {...(onCloseMessageMenu === undefined ? {} : { onCloseMenu: onCloseMessageMenu })}
                {...(onOpenMessageMenu === undefined ? {} : { onOpenMenu: () => { onOpenMessageMenu(message); } })}
                {...(onRetryUnavailableMessage === undefined ? {} : { onRetryUnavailableMessage })}
                {...(onToggleMessageSelection === undefined ? {} : { onToggleSelection: () => { onToggleMessageSelection(message); } })}
              />
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
          onClick={scrollToLatest}
          shape="circle"
          size="middle"
          tabIndex={showScrollToBottom ? 0 : -1}
          type="primary"
        />
      </Tooltip>
    </div>
  );
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

function ChatBubble({ menuOpen, message, onCloseMenu, onOpenMenu, onRetryUnavailableMessage, onToggleSelection, selected, selectionActive }: {
  readonly message: MessageSummary;
  readonly menuOpen: boolean;
  readonly selected: boolean;
  readonly selectionActive: boolean;
  readonly onCloseMenu?: () => void;
  readonly onOpenMenu?: () => void;
  readonly onRetryUnavailableMessage?: (message: MessageSummary) => void;
  readonly onToggleSelection?: () => void;
}): React.JSX.Element {
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressNextClick = useRef(false);
  const suppressNextContextMenu = useRef(false);
  const hasMessageActions = onToggleSelection !== undefined;
  const messageActions: MenuProps = {
    items: onToggleSelection === undefined ? [] : [
      { key: "select", icon: <SelectOutlined />, label: selected ? "Unselect message" : "Select message" }
    ],
    onClick: ({ key }) => {
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
        onClick={onBubbleClick}
        onPointerCancel={clearLongPress}
        onPointerDown={onPointerDown}
        onPointerLeave={clearLongPress}
        onPointerUp={clearLongPress}
      >
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

const longPressDurationMs = 550;

function ChatDayDivider({ timestamp }: { readonly timestamp: number }): React.JSX.Element {
  return <div className="pwa-chat-day-divider">{formatMessageDay(timestamp)}</div>;
}

function startsNewDay(previous: MessageSummary | null, current: MessageSummary): boolean {
  return previous === null || localDayKey(previous.sentAt) !== localDayKey(current.sentAt);
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

function DeliveryStateIcon({ state }: { readonly state: MessageDeliveryState }): React.JSX.Element {
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
