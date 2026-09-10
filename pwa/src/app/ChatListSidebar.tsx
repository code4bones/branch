import { InboxOutlined, RadarChartOutlined, SettingOutlined, UserAddOutlined } from "@ant-design/icons";
import { Badge, Button, Empty, Input, List, Modal, Space, Table, Tooltip, Typography } from "antd";
import { useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";

import { ChatAvatar } from "./ChatAvatar.js";
import { ContactTyping } from "./ContactTyping.js";
import { formatChatListTimestamp } from "./format-time.js";
import { chatPath, ECHO_PATH, MESSAGE_REQUESTS_PATH, SETTINGS_PATH } from "./paths.js";
import { pwaReleaseVersion } from "./pwa-release.js";
import { useChatList, useContactDiscoveries, useContactPresence, useContactTyping, useContacts, useEchoPreview, useIncomingMessageRequests, useTransportStatus } from "../state/hooks.js";
import { parseBranchID } from "@code4bones/branch-core";

export function ChatListSidebar(): React.JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const { contactId: activeContactId } = useParams<{ contactId?: string }>();
  const chatList = useChatList();
  const echoPreview = useEchoPreview();
  const transport = useTransportStatus();
  const messageRequests = useIncomingMessageRequests();
  const contactDiscovery = useContactDiscoveries();
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
          <Badge count={contactDiscovery.rows.filter((row) => row.displayName === null).length} offset={[-2, 2]} size="small">
            <Button aria-label="Add contact" icon={<UserAddOutlined />} onClick={() => { setAddContactOpen(true); }} type="text" />
          </Badge>
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
  const discovery = useContactDiscoveries();
  const [branchId, setBranchId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reset = (): void => {
    setBranchId("");
    setError(null);
  };

  const search = (): void => {
    const value = branchId.trim();
    try { parseBranchID(value); } catch { setError("Enter one complete valid BranchID."); return; }
    if (!discovery.search(value)) { setError("The local search list is full."); return; }
    setBranchId(""); setError(null);
  };

  const add = (row: typeof discovery.rows[number]): void => {
    if (row.displayName === null || row.peerId === null || row.hpkePublicKey === null) return;
    if (!contacts.contacts.some((contact) => contact.peerId === row.peerId)) contacts.upsertContact({ contactId: crypto.randomUUID(), displayName: row.displayName, peerId: row.peerId, hpkePublicKey: row.hpkePublicKey, lastRouteHint: null });
    discovery.remove(row.branchId);
  };

  return (
    <Modal
      onCancel={() => { reset(); onClose(); }}
      footer={null}
      open={open}
      title="Add contact"
    >
      <Space direction="vertical" style={{ width: "100%" }}>
        <Typography.Text type="secondary">
          Search one exact BranchID. This list stays only on this device and retries only while this PWA is open and attached to the same relay as the contact.
        </Typography.Text>
        {discovery.availability === "unsupported" && <Typography.Text type="warning">BranchID lookup is paused: the attached relay did not negotiate contact discovery.</Typography.Text>}
        {discovery.availability === "disabled" && <Typography.Text type="warning">BranchID lookup is disabled in Settings.</Typography.Text>}
        {discovery.availability === "unavailable" && <Typography.Text type="warning">BranchID lookup is waiting for a live relay attachment.</Typography.Text>}
        {error !== null && <Typography.Text type="danger">{error}</Typography.Text>}
        <Space.Compact style={{ width: "100%" }}><Input onChange={(event) => { setBranchId(event.currentTarget.value); }} onPressEnter={search} placeholder="BranchID" value={branchId} /><Button onClick={search} type="primary">Search</Button></Space.Compact>
        <Table
          columns={[
            { title: "ID", dataIndex: "branchId", key: "branchId", ellipsis: true },
            { title: "Display name", key: "displayName", render: (_, row) => row.displayName ?? "Not found yet" },
            { title: "Checked", key: "checked", render: (_, row) => row.lastCheckedAt === null ? "Never" : new Date(row.lastCheckedAt).toLocaleString() },
            { title: "Controls", key: "controls", render: (_, row) => <Space size={0}>{row.displayName === null ? <Button onClick={() => { discovery.retry(row.branchId); }} size="small" type="link">Retry</Button> : <Button onClick={() => { add(row); }} size="small" type="link">Add</Button>}<Button danger onClick={() => { discovery.remove(row.branchId); }} size="small" type="link">Delete</Button></Space> }
          ]}
          dataSource={[...discovery.rows]}
          pagination={false}
          rowKey="branchId"
          size="small"
        />
      </Space>
    </Modal>
  );
}
