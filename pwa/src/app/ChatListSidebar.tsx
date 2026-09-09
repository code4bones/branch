import { InboxOutlined, RadarChartOutlined, SettingOutlined, UserAddOutlined } from "@ant-design/icons";
import { Badge, Button, Empty, Input, List, Modal, Space, Tooltip, Typography } from "antd";
import { useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";

import { ChatAvatar } from "./ChatAvatar.js";
import { ContactTyping } from "./ContactTyping.js";
import { formatChatListTimestamp } from "./format-time.js";
import { chatPath, ECHO_PATH, MESSAGE_REQUESTS_PATH, SETTINGS_PATH } from "./paths.js";
import { pwaReleaseVersion } from "./pwa-release.js";
import { useChatList, useContactPresence, useContactTyping, useContacts, useEchoPreview, useIncomingMessageRequests, useTransportStatus } from "../state/hooks.js";

export function ChatListSidebar(): React.JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const { contactId: activeContactId } = useParams<{ contactId?: string }>();
  const chatList = useChatList();
  const echoPreview = useEchoPreview();
  const transport = useTransportStatus();
  const messageRequests = useIncomingMessageRequests();
  const [query, setQuery] = useState("");
  const [addContactOpen, setAddContactOpen] = useState(false);

  const needle = query.trim().toLowerCase();
  const filtered = needle === ""
    ? chatList
    : chatList.filter((entry) => entry.contact.displayName.toLowerCase().includes(needle));

  return (
    <aside className="pwa-sidebar" aria-label="Chats">
      <div className="pwa-sidebar-header">
        <div className="pwa-sidebar-title">
          <Typography.Title level={4}>Chats</Typography.Title>
          <Typography.Text className="pwa-release-version" type="secondary">v{pwaReleaseVersion}</Typography.Text>
          <Tooltip title={transport.attachMessage}>
            <span className={`pwa-attach-dot is-${transport.attachStatus}`} aria-label={`Relay: ${transport.attachStatus}`} />
          </Tooltip>
        </div>
        <Space>
          <Button aria-label="Add contact" icon={<UserAddOutlined />} onClick={() => { setAddContactOpen(true); }} type="text" />
          <Button
            aria-label="Settings"
            icon={<SettingOutlined />}
            onClick={() => { void navigate(SETTINGS_PATH); }}
            type="text"
          />
        </Space>
      </div>
      {messageRequests.requests.length > 0 && (
        <div className="pwa-message-request-link" onClick={() => { void navigate(MESSAGE_REQUESTS_PATH); }}>
          <InboxOutlined />
          <span>Message requests</span>
          <Badge count={messageRequests.requests.length} />
        </div>
      )}
      <Input.Search
        allowClear
        className="pwa-sidebar-search"
        onChange={(event) => { setQuery(event.currentTarget.value); }}
        placeholder="Search"
        value={query}
      />
      <div
        className={`pwa-echo-pinned${location.pathname === ECHO_PATH ? " is-active" : ""}`}
        onClick={() => { void navigate(ECHO_PATH); }}
      >
        <span className="pwa-echo-avatar"><RadarChartOutlined /></span>
        <div className="pwa-chat-list-text">
          <div className="pwa-chat-list-row">
            <span className="pwa-chat-list-name">Echo</span>
            {echoPreview.lastMessage !== null && (
              <span className="pwa-chat-list-time">{formatChatListTimestamp(echoPreview.lastMessage.sentAt)}</span>
            )}
          </div>
          <div className="pwa-chat-list-row">
            <span className="pwa-chat-list-preview">{echoPreview.lastMessage?.body ?? "Test your connection"}</span>
            {echoPreview.unreadCount > 0 && <Badge count={echoPreview.unreadCount} />}
          </div>
        </div>
      </div>
      {filtered.length === 0 ? (
        <Empty className="pwa-sidebar-empty" description="No chats yet" />
      ) : (
        <List
          className="pwa-chat-list"
          dataSource={[...filtered]}
          renderItem={(entry) => (
            <List.Item
              className={entry.contact.contactId === activeContactId ? "is-active" : ""}
              key={entry.contact.contactId}
              onClick={() => { void navigate(chatPath(entry.contact.contactId)); }}
            >
              <ChatAvatar name={entry.contact.displayName} />
              <div className="pwa-chat-list-text">
                <div className="pwa-chat-list-row">
                  <span className="pwa-chat-list-contact-name">
                    <span className="pwa-chat-list-name">{entry.contact.displayName}</span>
                    <ContactOnlineBadge contactId={entry.contact.contactId} />
                  </span>
                  {entry.lastMessage !== null && (
                    <span className="pwa-chat-list-time">{formatChatListTimestamp(entry.lastMessage.sentAt)}</span>
                  )}
                </div>
                <div className="pwa-chat-list-row">
                  <ContactPreview contactId={entry.contact.contactId} fallback={entry.lastMessage?.body ?? "No messages yet"} />
                  {entry.unreadCount > 0 && <Badge count={entry.unreadCount} />}
                </div>
              </div>
            </List.Item>
          )}
        />
      )}
      <AddContactModal onClose={() => { setAddContactOpen(false); }} open={addContactOpen} />
    </aside>
  );
}

function ContactPreview({ contactId, fallback }: { readonly contactId: string; readonly fallback: string }): React.JSX.Element {
  const { expiresAt } = useContactTyping(contactId);
  return expiresAt === null
    ? <span className="pwa-chat-list-preview">{fallback}</span>
    : <ContactTyping contactId={contactId} variant="list" />;
}

function ContactOnlineBadge({ contactId }: { readonly contactId: string }): React.JSX.Element | null {
  const { presence } = useContactPresence(contactId);
  if (presence.status !== "available") {
    return null;
  }
  return (
    <Tooltip title="Online (encrypted pong)">
      <span aria-label="Online (encrypted pong)" className="pwa-contact-online-badge" role="img">
        <Badge status="success" />
      </span>
    </Tooltip>
  );
}

function AddContactModal({ open, onClose }: { readonly open: boolean; readonly onClose: () => void }): React.JSX.Element {
  const contacts = useContacts();
  const [displayName, setDisplayName] = useState("");
  const [peerId, setPeerId] = useState("");
  const [hpkePublicKey, setHpkePublicKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reset = (): void => {
    setDisplayName("");
    setPeerId("");
    setHpkePublicKey("");
    setError(null);
  };

  const handlePasteInvite = (value: string): void => {
    try {
      const parsed = JSON.parse(value) as { readonly peerId?: unknown; readonly hpkePublicKey?: unknown; readonly displayName?: unknown };
      if (typeof parsed.peerId === "string") {
        setPeerId(parsed.peerId);
      }
      if (typeof parsed.hpkePublicKey === "string") {
        setHpkePublicKey(parsed.hpkePublicKey);
      }
      if (displayName.trim() === "" && typeof parsed.displayName === "string") {
        setDisplayName(parsed.displayName);
      }
    } catch {
      // Not an invite JSON blob — leave the peer id / key fields as typed.
    }
  };

  const handleSubmit = (): void => {
    const name = displayName.trim();
    const trimmedPeerId = peerId.trim();
    const trimmedHpkeKey = hpkePublicKey.trim();
    if (name === "" || trimmedPeerId === "" || trimmedHpkeKey === "") {
      setError("Display name, peer ID, and payload key are all required.");
      return;
    }
    if (contacts.contacts.some((existing) => existing.peerId === trimmedPeerId)) {
      setError("A contact with this peer ID already exists.");
      return;
    }
    contacts.upsertContact({
      contactId: crypto.randomUUID(),
      displayName: name,
      peerId: trimmedPeerId,
      hpkePublicKey: trimmedHpkeKey,
      lastRouteHint: null
    });
    reset();
    onClose();
  };

  return (
    <Modal
      okText="Add contact"
      onCancel={() => { reset(); onClose(); }}
      onOk={handleSubmit}
      open={open}
      title="Add contact"
    >
      <Space direction="vertical" style={{ width: "100%" }}>
        <Typography.Text type="secondary">
          Paste the connection info your contact copied from their Settings page, or fill in the
          fields manually.
        </Typography.Text>
        {error !== null && <Typography.Text type="danger">{error}</Typography.Text>}
        <Input onChange={(event) => { setDisplayName(event.currentTarget.value); }} placeholder="Display name" value={displayName} />
        <Input.TextArea
          onChange={(event) => { handlePasteInvite(event.currentTarget.value); }}
          placeholder='Paste connection info, e.g. {"peerId":"...","hpkePublicKey":"..."}'
          rows={2}
        />
        <Input onChange={(event) => { setPeerId(event.currentTarget.value); }} placeholder="Peer ID" value={peerId} />
        <Input onChange={(event) => { setHpkePublicKey(event.currentTarget.value); }} placeholder="Payload key (HPKE)" value={hpkePublicKey} />
      </Space>
    </Modal>
  );
}
