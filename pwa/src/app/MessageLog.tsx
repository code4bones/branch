import { DownOutlined } from "@ant-design/icons";
import { Button, Empty, Tooltip } from "antd";
import { Fragment, useCallback, useLayoutEffect, useRef, useState } from "react";

import type { MessageDeliveryState, MessageSummary } from "../state/slices/conversations-slice.js";

const bottomThresholdPx = 48;

export function MessageLog({ contactId, messages, emptyDescription }: {
  readonly contactId: string;
  readonly messages: readonly MessageSummary[];
  readonly emptyDescription: string;
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

    if (openedDifferentConversation || stickToBottom.current || newest?.direction === "outgoing") {
      scrollToLatest();
    } else if (receivedNewMessage) {
      setShowLatest(true);
    }

    previous.current = { contactId, count: messages.length, newestId: newest?.messageId ?? null };
  }, [contactId, messages.length, newest?.direction, newest?.messageId, scrollToLatest]);

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

function ChatBubble({ message }: { readonly message: MessageSummary }): React.JSX.Element {
  return (
    <article className={`pwa-chat-message is-${message.direction}`}>
      <span className="pwa-chat-message-body">{message.body}</span>
      <footer className="pwa-chat-message-meta">
        <time dateTime={new Date(message.sentAt).toISOString()}>{formatMessageTime(message.sentAt)}</time>
        {message.direction === "outgoing" && <span>{formatDeliveryState(message.deliveryState)}</span>}
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

function formatDeliveryState(state: MessageDeliveryState): string {
  switch (state) {
    case "pending":
      return "Sending";
    case "relayed":
      return "Relayed";
    case "received":
      return "Delivered";
    case "unavailable":
      return "Unavailable";
  }
}
