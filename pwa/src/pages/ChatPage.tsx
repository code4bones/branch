import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { DeleteOutlined, EditOutlined, SettingOutlined } from "@ant-design/icons";
import { Button, Dropdown, Empty, Input, Modal, Tag, Tooltip } from "antd";
import type { MenuProps } from "antd";

import { ChatAvatar } from "../app/ChatAvatar.js";
import { ContactPresence } from "../app/ContactPresence.js";
import { DetailHeader } from "../app/DetailHeader.js";
import { AttachmentSendControl } from "../app/AttachmentSendControl.js";
import { InboundAttachmentOffer } from "../app/InboundAttachmentOffer.js";
import { MessageComposer } from "../app/MessageComposer.js";
import { MessageLog } from "../app/MessageLog.js";
import { VerifiedCompletedAttachment } from "../app/VerifiedCompletedAttachment.js";
import { clearTransientCompletedAttachment } from "../app/transient-attachment-presentation.js";
import { peerSupportsChatText, sendApplicationCapabilities } from "../connectivity/application-capabilities-control.js";
import { sendDeliveryReceipt } from "../connectivity/delivery-receipt-control.js";
import { getRelaySessionClient, hasAttachedRelaySession } from "../connectivity/relay-session.js";
import { createDeliveryID, sealAndSendApplicationTextMessage, sealAndSendMessage } from "../connectivity/seal-and-send.js";
import { sendTypingControl } from "../connectivity/typing-control.js";
import { CHATS_PATH } from "../app/paths.js";
import { useCompletedAttachment, useContacts, useConversation, useIdentity, useInboundAttachmentOffer, useMarkContactRead, useReceiptPolicy, useTransportStatus } from "../state/hooks.js";
import type { MessageSummary } from "../state/slices/conversations-slice.js";
import { useAppStoreApi } from "../state/StoreProvider.js";

export function ChatPage(): React.JSX.Element {
  const navigate = useNavigate();
  const { contactId } = useParams<{ contactId?: string }>();
  const resolvedContactId = contactId ?? null;
  const contacts = useContacts();
  const conversation = useConversation(resolvedContactId);
  const identity = useIdentity();
  const transport = useTransportStatus();
  const receiptPolicy = useReceiptPolicy();
  const storeApi = useAppStoreApi();
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [displayName, setDisplayName] = useState("");

  useMarkContactRead(resolvedContactId);

  const contact = contacts.contacts.find((candidate) => candidate.contactId === resolvedContactId) ?? null;
  const inboundAttachmentOffer = useInboundAttachmentOffer(contact?.peerId ?? null);
  const completedAttachment = useCompletedAttachment(contact?.peerId ?? null);

  useEffect(() => {
    if (contact !== null) {
      contacts.selectContact(contact.contactId);
    }
  }, [contact?.contactId, contacts.selectContact]);

  useEffect(() => {
    const peerId = contact?.peerId ?? null;
    if (peerId === null) {
      return;
    }
    return () => { clearTransientCompletedAttachment(storeApi, peerId); };
  }, [contact?.peerId, storeApi]);

  useEffect(() => {
    if (contact === null || contact.peerId === null || contact.hpkePublicKey === null || transport.attachStatus !== "attached") {
      return;
    }
    getRelaySessionClient()?.rendezvous(contact.peerId);
  }, [contact, transport.attachStatus]);

  // Capabilities are volatile and deliberately forgotten on reload. Opening a
  // live known-contact chat re-advertises this endpoint's bounded attachment
  // policy; the recipient answers a valid advertisement once (rate-limited)
  // so either peer can safely offer without a text-message warm-up.
  useEffect(() => {
    if (contact === null || contact.peerId === null || contact.hpkePublicKey === null || identity.identity === null || transport.attachStatus !== "attached") {
      return;
    }
    void sendApplicationCapabilities({
      senderPeerId: identity.identity.peerId,
      recipientPeerId: contact.peerId,
      recipientHpkePublicKey: contact.hpkePublicKey,
      attached: true
    }).then((result) => {
      storeApi.getState().recordTransportTrace(`application capabilities: chat_${result}`);
    }).catch(() => {
      storeApi.getState().recordTransportTrace("application capabilities: chat_failed");
    });
  }, [contact, identity.identity, storeApi, transport.attachStatus]);

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
    if (peerId !== null) {
      clearTransientCompletedAttachment(storeApi, peerId);
    }
    contacts.forgetContact(contact.contactId);
    void navigate(CHATS_PATH);
  };

  const contactActions: MenuProps = {
    items: [
      { key: "rename", icon: <EditOutlined />, label: "Rename contact" },
      { key: "remove", danger: true, icon: <DeleteOutlined />, label: "Remove contact" }
    ],
    onClick: ({ key }) => {
      if (key === "rename") {
        openRename();
        return;
      }
      if (key === "remove") {
        setRemoveOpen(true);
      }
    }
  };

  const sendBody = (body: string, previousUnavailableMessage?: MessageSummary): void => {
    if (body === "" || identity.identity === null) {
      return;
    }
    setSendError(null);
    const deliveryId = createDeliveryID();
    const pendingMessage: MessageSummary = {
      messageId: deliveryId,
      contactId: contact.contactId,
      direction: "outgoing",
      body,
      sentAt: previousUnavailableMessage?.sentAt ?? Date.now(),
      deliveryState: "pending"
    };
    if (previousUnavailableMessage === undefined) {
      conversation.appendMessage(pendingMessage);
    } else if (!conversation.retryUnavailableMessage(contact.contactId, previousUnavailableMessage.messageId, pendingMessage)) {
      return;
    }

    if (peerId !== null && hpkePublicKey !== null && hasAttachedRelaySession()) {
      const supportsGenericText = peerSupportsChatText(peerId);
      const send = supportsGenericText
        ? sealAndSendApplicationTextMessage({
          senderPeerId: identity.identity.peerId,
          recipientPeerId: peerId,
          recipientHpkePublicKey: hpkePublicKey,
          contactId: contact.contactId,
          deliveryId,
          plaintext: body,
          onRelayOutcomeTimeout: () => {
            conversation.setMessageDeliveryState(contact.contactId, deliveryId, "unavailable");
          }
        })
        : sealAndSendMessage({
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
        });
      void send.catch((cause: unknown) => {
        conversation.setMessageDeliveryState(contact.contactId, deliveryId, "unavailable");
        setSendError(cause instanceof Error ? cause.message : "send failed");
      });
      if (!supportsGenericText) {
        void sendApplicationCapabilities({
          senderPeerId: identity.identity.peerId,
          recipientPeerId: peerId,
          recipientHpkePublicKey: hpkePublicKey,
          attached: true
        }).then((result) => {
          if (result === "sent") {
            storeApi.getState().recordTransportTrace("application capabilities: outbound_sent");
          }
        }).catch(() => {
          // Advisory capabilities are never queued and do not alter the visible
          // compatibility message's own live delivery outcome.
        });
      }
      return;
    }
    if (isReachable) {
      conversation.setMessageDeliveryState(contact.contactId, deliveryId, "unavailable");
      setSendError("relay is not attached");
    }
    // A contact without complete verified route material stays local and is
    // never sent as a plaintext fallback.
  };

  const handleSend = (): void => {
    const body = draft.trim();
    if (body === "" || identity.identity === null) {
      return;
    }
    setDraft("");
    sendBody(body);
  };

  const retryUnavailableMessage = (message: MessageSummary): void => {
    if (message.direction !== "outgoing" || message.deliveryState !== "unavailable") {
      return;
    }
    sendBody(message.body, message);
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

  const handleIncomingMessageAutoPresented = (message: MessageSummary): void => {
    if (!receiptPolicy.sendReadReceipts || identity.identity === null || peerId === null || hpkePublicKey === null || message.direction !== "incoming") {
      return;
    }
    void sendDeliveryReceipt({
      kind: "read",
      targetDeliveryId: message.messageId,
      senderPeerId: identity.identity.peerId,
      recipientPeerId: peerId,
      recipientHpkePublicKey: hpkePublicKey,
      attached: hasAttachedRelaySession()
    }).then((result) => {
      storeApi.getState().recordTransportTrace(`delivery receipt: read_${result}`);
    }).catch(() => {
      // Read is a best-effort live control. It is never queued or retried
      // merely because a visible message's relay path is no longer live.
      storeApi.getState().recordTransportTrace("delivery receipt: read_failed");
    });
  };

  return (
    <section className="pwa-chat" aria-label={`Chat with ${contact.displayName}`}>
      <DetailHeader
        avatar={<ChatAvatar name={contact.displayName} size={42} />}
        extra={
          !isReachable
            ? <Tag>contact unavailable</Tag>
            : (
              <Dropdown menu={contactActions} placement="bottomRight" trigger={["click"]}>
                <Tooltip title="Contact settings">
                  <Button aria-label="Contact settings" icon={<SettingOutlined />} type="text" />
                </Tooltip>
              </Dropdown>
            )
        }
        subtitle={isReachable ? <ContactPresence contact={contact} /> : "Contact unavailable"}
        title={contact.displayName}
      />
      <InboundAttachmentOffer offer={inboundAttachmentOffer.offer} onDecision={(decision) => { void inboundAttachmentOffer.respond(decision); }} />
      <VerifiedCompletedAttachment attachment={completedAttachment.attachment} onDownload={() => {
        if (completedAttachment.download() !== "downloaded") {
          setSendError("That verified file is no longer available in this live tab.");
        }
      }} />
      <MessageLog contactId={contact.contactId} emptyDescription="No messages yet." messages={conversation.messages} onIncomingMessageAutoPresented={handleIncomingMessageAutoPresented} onRetryUnavailableMessage={retryUnavailableMessage} />
      {sendError !== null && <div className="pwa-chat-error">{sendError}</div>}
      <div className="pwa-chat-compose-row">
        {peerId !== null && hpkePublicKey !== null && <AttachmentSendControl peerId={peerId} />}
        <MessageComposer
          onChange={setDraft}
          onSend={handleSend}
          placeholder={isReachable ? "Message" : "Messaging is unavailable until this contact has a live identity route"}
          value={draft}
          {...(isReachable ? { onTyping: handleTyping } : {})}
        />
      </div>
      <Modal
        okText="Save"
        onCancel={() => { setRenameOpen(false); }}
        onOk={saveRename}
        open={renameOpen}
        title="Rename contact"
      >
        <Input autoFocus onChange={(event) => { setDisplayName(event.currentTarget.value); }} value={displayName} />
      </Modal>
      <Modal
        cancelText="Cancel"
        okButtonProps={{ danger: true }}
        okText="Remove"
        onCancel={() => { setRemoveOpen(false); }}
        onOk={forgetContact}
        open={removeOpen}
        title="Remove contact?"
      >
        This deletes the contact and its local chat history from this device.
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
