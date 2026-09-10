import { CopyOutlined, FolderAddOutlined, FolderOutlined, InboxOutlined, PaperClipOutlined, SettingOutlined, UserAddOutlined } from "@ant-design/icons";
import { Badge, Button, Dropdown, Empty, Input, List, Modal, Select, Space, Table, Tooltip, Typography } from "antd";
import type { MenuProps } from "antd";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { ChatAvatar } from "./ChatAvatar.js";
import { ContactTyping } from "./ContactTyping.js";
import { formatChatListTimestamp } from "./format-time.js";
import { chatPath, MESSAGE_REQUESTS_PATH, SETTINGS_PATH } from "./paths.js";
import { pwaReleaseVersion } from "./pwa-release.js";
import { useBranchID } from "../identity/use-branch-id.js";
import { useChatList, useContactDiscoveries, useContactFolders, useContactPresence, useContactTyping, useContacts, useIdentity, useInboundAttachmentOffer, useIncomingMessageRequests, useTransportStatus, type ChatListEntry } from "../state/hooks.js";
import { filterChatListByFolder } from "../state/contact-folder-filter.js";
import { parseBranchID } from "@code4bones/branch-core";

export function ChatListSidebar(): React.JSX.Element {
  const navigate = useNavigate();
  const { contactId: activeContactId } = useParams<{ contactId?: string }>();
  const chatList = useChatList();
  const identity = useIdentity();
  const transport = useTransportStatus();
  const messageRequests = useIncomingMessageRequests();
  const contactDiscovery = useContactDiscoveries();
  const contactFolders = useContactFolders();
  const [query, setQuery] = useState("");
  const [addContactOpen, setAddContactOpen] = useState(false);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);

  const needle = query.trim().toLowerCase();
  const activeFolderId = selectedFolderId !== null && contactFolders.folders.some((folder) => folder.folderId === selectedFolderId)
    ? selectedFolderId
    : null;
  const folderFiltered = filterChatListByFolder(chatList, activeFolderId, contactFolders.folderIdByContactId);
  const filtered = needle === ""
    ? folderFiltered
    : folderFiltered.filter((entry) => entry.contact.displayName.toLowerCase().includes(needle));
  const localDisplayName = identity.identity?.displayName ?? "B.R.A.N.C.H.";
  const branchID = useBranchID(identity.identity?.peerId ?? null);
  const folderMenu: MenuProps = {
    items: [
      { key: "all", icon: <FolderOutlined />, label: "All" },
      ...contactFolders.folders.map((folder) => ({ key: folder.folderId, icon: <FolderOutlined />, label: folder.name })),
      { type: "divider" },
      { key: "new", icon: <FolderAddOutlined />, label: "New folder" }
    ],
    onClick: ({ key }) => {
      if (key === "new") {
        setNewFolderOpen(true);
      } else {
        setSelectedFolderId(key === "all" ? null : key);
      }
    }
  };
  const folderLabel = activeFolderId === null
    ? "All"
    : contactFolders.folders.find((folder) => folder.folderId === activeFolderId)?.name ?? "All";

  const copyBranchID = (): void => {
    if (branchID !== null) {
      void navigator.clipboard.writeText(branchID);
    }
  };

  return (
    <aside className="pwa-sidebar" aria-label="Chats">
      <div className="pwa-sidebar-header">
        <div className="pwa-sidebar-title">
          <Typography.Text className="pwa-local-identity-name" ellipsis>{localDisplayName}</Typography.Text>
          <Tooltip title={branchID === null ? "Preparing BranchID" : "Copy BranchID"}>
            <Button
              aria-label="Copy BranchID"
              className="pwa-copy-branch-id"
              disabled={branchID === null}
              icon={<CopyOutlined />}
              onClick={copyBranchID}
              size="small"
              type="text"
            />
          </Tooltip>
          <Tooltip title={transport.attachMessage}>
            <span className={`pwa-attach-dot is-${transport.attachStatus}`} aria-label={`Relay: ${transport.attachStatus}`} />
          </Tooltip>
        </div>
        <Typography.Text className="pwa-release-version pwa-sidebar-release-version" type="secondary">v{pwaReleaseVersion}</Typography.Text>
        <Space className="pwa-sidebar-actions">
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
      <div className="pwa-contact-list-controls">
        {contactFolders.folders.length > 0 && (
          <Dropdown menu={folderMenu} trigger={["click"]}>
            <Button aria-label="Contact folder" className="pwa-contact-folder-filter" icon={<FolderOutlined />}>
              {folderLabel}
            </Button>
          </Dropdown>
        )}
        <Input.Search
          allowClear
          className="pwa-sidebar-search"
          onChange={(event) => { setQuery(event.currentTarget.value); }}
          placeholder="Search"
          value={query}
        />
      </div>
      <div className="pwa-chat-list-container">
        {filtered.length === 0 ? (
          chatList.length === 0 ? (
            <div className="pwa-empty-contact-list">
              <Button icon={<UserAddOutlined />} onClick={() => { setAddContactOpen(true); }} type="primary">
                Add contact
              </Button>
            </div>
          ) : <Empty className="pwa-sidebar-empty" description="No matching chats" />
        ) : (
          <List
            className="pwa-chat-list"
            dataSource={[...filtered]}
            renderItem={(entry) => <ChatListItem activeContactId={activeContactId} entry={entry} navigateToChat={(contactId) => { void navigate(chatPath(contactId)); }} />}
            split={false}
          />
        )}
      </div>
      <AddContactModal onClose={() => { setAddContactOpen(false); }} open={addContactOpen} />
      <NewContactFolderModal onClose={() => { setNewFolderOpen(false); }} onCreated={(folderId) => { setSelectedFolderId(folderId); }} open={newFolderOpen} />
    </aside>
  );
}

function ChatListItem({ activeContactId, entry, navigateToChat }: { readonly activeContactId: string | undefined; readonly entry: ChatListEntry; readonly navigateToChat: (contactId: string) => void }): React.JSX.Element {
  const [addToFolderOpen, setAddToFolderOpen] = useState(false);
  const contactMenu: MenuProps = {
    items: [{ key: "add-to-folder", icon: <FolderAddOutlined />, label: "Add to folder" }],
    onClick: () => { setAddToFolderOpen(true); }
  };
  return (
    <>
      <Dropdown menu={contactMenu} trigger={["contextMenu"]}>
        <List.Item
          className={entry.contact.contactId === activeContactId ? "is-active" : ""}
          key={entry.contact.contactId}
          onClick={() => { navigateToChat(entry.contact.contactId); }}
        >
          <ChatAvatar name={entry.contact.displayName} size={48} />
          <div className="pwa-chat-list-text">
            <div className="pwa-chat-list-row">
              <span className="pwa-chat-list-contact-name">
                <span className="pwa-chat-list-name">{entry.contact.displayName}</span>
                <ContactOnlineBadge contactId={entry.contact.contactId} />
                {entry.contact.peerId !== null && <IncomingAttachmentBadge peerId={entry.contact.peerId} />}
              </span>
              {entry.lastMessage !== null && <span className="pwa-chat-list-time">{formatChatListTimestamp(entry.lastMessage.sentAt)}</span>}
            </div>
            <div className="pwa-chat-list-row">
              <ContactPreview contactId={entry.contact.contactId} fallback={entry.lastMessage?.body ?? "No messages yet"} />
              {entry.unreadCount > 0 && <Badge count={entry.unreadCount} />}
            </div>
          </div>
        </List.Item>
      </Dropdown>
      <AddContactToFolderModal contactId={entry.contact.contactId} onClose={() => { setAddToFolderOpen(false); }} open={addToFolderOpen} />
    </>
  );
}

function NewContactFolderModal({ open, onClose, onCreated }: { readonly open: boolean; readonly onClose: () => void; readonly onCreated: (folderId: string) => void }): React.JSX.Element {
  const folders = useContactFolders();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const create = (): void => {
    const folderId = folders.create(name);
    if (folderId === null) {
      setError("Choose a unique folder name of up to 48 characters.");
      return;
    }
    setName(""); setError(null); onCreated(folderId); onClose();
  };
  return (
    <Modal okText="Create" onCancel={onClose} onOk={create} open={open} title="New folder">
      <Input autoFocus onChange={(event) => { setName(event.currentTarget.value); }} onPressEnter={create} placeholder="Folder name" value={name} />
      {error !== null && <Typography.Text type="danger">{error}</Typography.Text>}
    </Modal>
  );
}

function AddContactToFolderModal({ contactId, open, onClose }: { readonly contactId: string; readonly open: boolean; readonly onClose: () => void }): React.JSX.Element {
  const folders = useContactFolders();
  const [folderId, setFolderId] = useState<string | null>(folders.folderIdByContactId[contactId] ?? null);
  const [newFolderName, setNewFolderName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const assign = (): void => {
    const nextFolderId = newFolderName.trim() === "" ? folderId : folders.create(newFolderName);
    if (nextFolderId === null) {
      setError("Choose a folder or enter a unique name of up to 48 characters.");
      return;
    }
    if (!folders.assign(contactId, nextFolderId)) {
      setError("That folder is no longer available.");
      return;
    }
    setNewFolderName(""); setError(null); onClose();
  };
  return (
    <Modal okText="Add" onCancel={onClose} onOk={assign} open={open} title="Add to folder">
      <Space direction="vertical" style={{ width: "100%" }}>
        {folders.folders.length > 0 && (
          <Select
            onChange={(value: string) => { setFolderId(value); setNewFolderName(""); }}
            options={folders.folders.map((folder) => ({ label: folder.name, value: folder.folderId }))}
            placeholder="Choose a folder"
            value={newFolderName === "" ? folderId : null}
          />
        )}
        <Input
          onChange={(event) => { setNewFolderName(event.currentTarget.value); }}
          placeholder={folders.folders.length === 0 ? "Create a folder" : "Or create a new folder"}
          value={newFolderName}
        />
        {error !== null && <Typography.Text type="danger">{error}</Typography.Text>}
      </Space>
    </Modal>
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
  const title = presence.evidence === "encrypted_live_traffic"
    ? "Contact online (encrypted live traffic)"
    : "Contact online (encrypted pong)";
  return (
    <Tooltip title={title}>
      <span aria-label="online" className="pwa-contact-online-badge" role="img">
        <Badge status="success" />
      </span>
    </Tooltip>
  );
}

// An offer is live, consent-gated metadata, not a chat message. Keep it
// discoverable even when its chat is not the currently open detail pane;
// selecting the chat is still required before the user can accept or reject.
function IncomingAttachmentBadge({ peerId }: { readonly peerId: string }): React.JSX.Element | null {
  const { offer } = useInboundAttachmentOffer(peerId);
  if (offer === null) {
    return null;
  }
  return (
    <Tooltip title="Incoming file offer — open this chat">
      <span aria-label="Incoming file offer" className="pwa-incoming-attachment-badge" role="img">
        <Badge dot><PaperClipOutlined /></Badge>
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
