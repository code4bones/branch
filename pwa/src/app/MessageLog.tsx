import { CheckOutlined, ExclamationCircleOutlined, LoadingOutlined, DownOutlined } from "@ant-design/icons";
import { Button, Empty, Tooltip } from "antd";
import { Fragment, useCallback, useLayoutEffect, useRef, useState } from "react";

import type { MessageDeliveryState, MessageSummary } from "../state/slices/conversations-slice.js";

const bottomThresholdPx = 48;

export function MessageLog({ contactId, messages, emptyDescription, onIncomingMessageAutoPresented }: {
  readonly contactId: string;
  readonly messages: readonly MessageSummary[];
  readonly emptyDescription: string;
  // This reports only the newest incoming message that this log has actually
  // auto-scrolled into the active view. It intentionally does not fire for an
  // unread message while the reader has scrolled away from the bottom.
  readonly onIncomingMessageAutoPresented?: (message: MessageSummary) => void;
}): React.JSX.Element {
  const logRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const previous = useRef<{ readonly contactId: string | null; readonly count: number; readonly newestId: string | null }>({
    contactId: null,
    count: 0,
    newestId: null
  });
  const [showLatest, setShowLatest] = useState(false);
  const newest = messages.at(-1) ?? null;

  const scrollToLatest = useCallback((): void => {
    const node = logRef.current;
    if (node === null) {
      return;
    }
    node.scrollTop = node.scrollHeight;
    stickToBottom.current = true;
    setShowLatest(false);
  }, []);

  const onScroll = useCallback((): void => {
    const node = logRef.current;
    if (node === null) {
      return;
    }
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight <= bottomThresholdPx;
    stickToBottom.current = atBottom;
    if (atBottom) {
      setShowLatest(false);
    }
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
      setShowLatest(true);
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
              <ChatBubble message={message} />
            </Fragment>
          ))
        )}
      </div>
      {showLatest && (
        <Tooltip title="Jump to latest message">
          <Button
            aria-label="Jump to latest message"
            className="pwa-chat-latest-button"
            icon={<DownOutlined />}
            onClick={scrollToLatest}
            shape="circle"
            type="primary"
          />
        </Tooltip>
      )}
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
  if (options.newest.messageId === options.previousNewestId) {
    return null;
  }
  return options.openedDifferentConversation || options.wasAtBottom ? options.newest : null;
}

function ChatBubble({ message }: { readonly message: MessageSummary }): React.JSX.Element {
  return (
    <article className={`pwa-chat-message is-${message.direction}`}>
      <span className="pwa-chat-message-body">{message.body}</span>
      <footer className="pwa-chat-message-meta">
        <time dateTime={new Date(message.sentAt).toISOString()}>{formatMessageTime(message.sentAt)}</time>
        {message.direction === "outgoing" && <DeliveryStateIcon state={message.deliveryState} />}
      </footer>
    </article>
  );
}

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
        {presentation.icon}
      </span>
    </Tooltip>
  );
}

function deliveryStatePresentation(state: MessageDeliveryState): { readonly label: string; readonly icon: React.JSX.Element } {
  switch (state) {
    case "pending":
      return { label: "Sending", icon: <LoadingOutlined spin /> };
    case "relayed":
      return { label: "Relayed", icon: <CheckOutlined /> };
    case "delivered":
      return { label: "Delivered", icon: <DoubleCheckIcon /> };
    case "read":
      return { label: "Read", icon: <DoubleCheckIcon /> };
    case "received":
      return { label: "Received (legacy)", icon: <DoubleCheckIcon /> };
    case "unavailable":
      return { label: "Unavailable", icon: <ExclamationCircleOutlined /> };
  }
}

function DoubleCheckIcon(): React.JSX.Element {
  return (
    <span aria-hidden="true" className="pwa-chat-delivery-double-check">
      <CheckOutlined />
      <CheckOutlined />
    </span>
  );
}
