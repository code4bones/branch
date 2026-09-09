import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { DeleteOutlined, EditOutlined } from "@ant-design/icons";
import { Button, Empty, Input, Modal, Popconfirm, Space, Tag, Tooltip } from "antd";

import { ChatAvatar } from "../app/ChatAvatar.js";
import { ContactPresence } from "../app/ContactPresence.js";
import { ContactRouteLookup } from "../app/ContactRouteLookup.js";
import { DetailHeader } from "../app/DetailHeader.js";
import { MessageComposer } from "../app/MessageComposer.js";
import { MessageLog } from "../app/MessageLog.js";
import { getRelaySessionClient, hasAttachedRelaySession } from "../connectivity/relay-session.js";
import { createDeliveryID, sealAndSendMessage } from "../connectivity/seal-and-send.js";
import { sendTypingControl } from "../connectivity/typing-control.js";
import { CHATS_PATH } from "../app/paths.js";
import { useContacts, useConversation, useIdentity, useMarkContactRead, useTransportStatus } from "../state/hooks.js";
import { useAppStoreApi } from "../state/StoreProvider.js";

export function ChatPage(): React.JSX.Element {
  const navigate = useNavigate();
  const { contactId } = useParams<{ contactId?: string }>();
  const resolvedContactId = contactId ?? null;
  const contacts = useContacts();
  const conversation = useConversation(resolvedContactId);
  const identity = useIdentity();
  const transport = useTransportStatus();
  const storeApi = useAppStoreApi();
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [displayName, setDisplayName] = useState("");

  useMarkContactRead(resolvedContactId);

  const contact = contacts.contacts.find((candidate) => candidate.contactId === resolvedContactId) ?? null;

  useEffect(() => {
    if (contact === null || contact.peerId === null || contact.hpkePublicKey === null || transport.attachStatus !== "attached") {
      return;
    }
    getRelaySessionClient()?.rendezvous(contact.peerId);
  }, [contact, transport.attachStatus]);

  if (contact === null) {
    return (
      <section className="pwa-chat" aria-label="Chat">
        <Empty description="Select a contact to open a conversation." />
      </section>
    );
  }

  const peerId = contact.peerId;
  const hpkePublicKey = contact.hpkePublicKey;
  const isReachable = peerId !== null && hpkePublicKey !== null;

  const openRename = (): void => {
    setDisplayName(contact.displayName);
    setRenameOpen(true);
  };

  const saveRename = (): void => {
    const nextName = displayName.trim();
    if (nextName === "") {
      return;
    }
    contacts.upsertContact({ ...contact, displayName: nextName });
    setRenameOpen(false);
  };

  const forgetContact = (): void => {
    contacts.forgetContact(contact.contactId);
    void navigate(CHATS_PATH);
  };

  const handleSend = (): void => {
    const body = draft.trim();
    if (body === "" || identity.identity === null) {
      return;
    }
    setSendError(null);
    const deliveryId = createDeliveryID();
    conversation.appendMessage({
      messageId: deliveryId,
      contactId: contact.contactId,
      direction: "outgoing",
      body,
      sentAt: Date.now(),
      deliveryState: "pending"
    });
    setDraft("");

    if (peerId !== null && hpkePublicKey !== null && hasAttachedRelaySession()) {
      sealAndSendMessage({
        senderPeerId: identity.identity.peerId,
        senderHpkePublicKey: identity.identity.hpkePublicKey,
        senderDisplayName: identity.identity.displayName ?? "Branch peer",
        recipientPeerId: peerId,
        recipientHpkePublicKey: hpkePublicKey,
        contactId: contact.contactId,
        deliveryId,
        plaintext: body,
        onRelayOutcomeTimeout: () => {
          conversation.setMessageDeliveryState(contact.contactId, deliveryId, "unavailable");
        }
      }).catch((cause: unknown) => {
        conversation.setMessageDeliveryState(contact.contactId, deliveryId, "unavailable");
        setSendError(cause instanceof Error ? cause.message : "send failed");
      });
      return;
    }
    if (isReachable) {
      conversation.setMessageDeliveryState(contact.contactId, deliveryId, "unavailable");
      setSendError("relay is not attached");
    }
    // Demo contacts deliberately remain local-only UI samples.
  };

  const handleTyping = (): void => {
    if (identity.identity === null || peerId === null || hpkePublicKey === null) {
      return;
    }
    void sendTypingControl({
      senderPeerId: identity.identity.peerId,
      recipientPeerId: peerId,
      recipientHpkePublicKey: hpkePublicKey,
      attached: hasAttachedRelaySession()
    }).then((result) => {
      if (result === "sent") {
        storeApi.getState().recordTransportTrace("typing control: outbound_sent");
      }
    }).catch((cause: unknown) => {
      storeApi.getState().recordTransportTrace(`typing control: ${typingSendFailure(cause)}`);
    });
  };

  return (
    <section className="pwa-chat" aria-label={`Chat with ${contact.displayName}`}>
      <DetailHeader
        avatar={<ChatAvatar name={contact.displayName} size={36} />}
        extra={
          !isReachable
            ? <Tag>demo contact</Tag>
            : (
              <Space size={0}>
                <Tooltip title="Rename contact">
                  <Button aria-label="Rename contact" icon={<EditOutlined />} onClick={openRename} type="text" />
                </Tooltip>
                <Popconfirm
                  cancelText="Cancel"
                  description="This deletes the contact and its local chat history from this device."
                  okButtonProps={{ danger: true }}
                  okText="Remove"
                  onConfirm={forgetContact}
                  title="Remove contact?"
                >
                  <Tooltip title="Remove contact">
                    <Button aria-label="Remove contact" danger icon={<DeleteOutlined />} type="text" />
                  </Tooltip>
                </Popconfirm>
              </Space>
            )
        }
        subtitle={isReachable ? <ContactPresence contact={contact} /> : "Demo contact"}
        title={contact.displayName}
      />
      {isReachable && <ContactRouteLookup peerId={peerId} />}
      <MessageLog contactId={contact.contactId} emptyDescription="No messages yet." messages={conversation.messages} />
      {sendError !== null && <div className="pwa-chat-error">{sendError}</div>}
      <MessageComposer
        onChange={setDraft}
        onSend={handleSend}
        placeholder={isReachable ? "Message" : "Message body is not yet end-to-end sealed for demo contacts"}
        value={draft}
        {...(isReachable ? { onTyping: handleTyping } : {})}
      />
      <Modal
        okText="Save"
        onCancel={() => { setRenameOpen(false); }}
        onOk={saveRename}
        open={renameOpen}
        title="Rename contact"
      >
        <Input autoFocus onChange={(event) => { setDisplayName(event.currentTarget.value); }} value={displayName} />
      </Modal>
    </section>
  );
}

function typingSendFailure(cause: unknown): "relay_not_attached" | "protocol_error" | "send_failed" {
  if (cause instanceof Error && cause.message === "relay session is not attached") {
    return "relay_not_attached";
  }
  if (cause instanceof Error && /invalid|protocol|frame/iu.test(cause.message)) {
    return "protocol_error";
  }
  return "send_failed";
}
