import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { DeleteOutlined, EditOutlined, ForwardOutlined, SettingOutlined } from "@ant-design/icons";
import { Button, Dropdown, Empty, Input, Modal, Select, Tag, Tooltip } from "antd";
import type { MenuProps } from "antd";

import { ChatAvatar } from "../app/ChatAvatar.js";
import { ContactPresence } from "../app/ContactPresence.js";
import { DetailHeader } from "../app/DetailHeader.js";
import { AttachmentSendControl } from "../app/AttachmentSendControl.js";
import { InboundAttachmentOffer } from "../app/InboundAttachmentOffer.js";
import { MessageComposer } from "../app/MessageComposer.js";
import { MessageLog } from "../app/MessageLog.js";
import { composeOutgoingText } from "../app/message-composition.js";
import { VerifiedCompletedAttachment } from "../app/VerifiedCompletedAttachment.js";
import { clearTransientCompletedAttachment } from "../app/transient-attachment-presentation.js";
import { peerSupportsChatText, sendApplicationCapabilities } from "../connectivity/application-capabilities-control.js";
import { getRelaySessionClient, hasAttachedRelaySession } from "../connectivity/relay-session.js";
import { createDeliveryID } from "../connectivity/seal-and-send.js";
import { sendTypingControl } from "../connectivity/typing-control.js";
import { CHATS_PATH } from "../app/paths.js";
import { useCompletedAttachment, useContacts, useConversation, useIdentity, useInboundAttachmentOffer, useMarkContactRead, useMessageActions, useReceiptPolicy, useTransportStatus } from "../state/hooks.js";
import type { ContactSummary } from "../state/slices/contacts-slice.js";
import type { MessageSummary } from "../state/slices/conversations-slice.js";
import { useAppStoreApi } from "../state/StoreProvider.js";

export function ChatPage(): React.JSX.Element {
  const navigate = useNavigate();
  const { contactId } = useParams<{ contactId?: string }>();
  const resolvedContactId = contactId ?? null;
  const contacts = useContacts();
  const conversation = useConversation(resolvedContactId);
  const messageActions = useMessageActions();
  const identity = useIdentity();
  const transport = useTransportStatus();
  const receiptPolicy = useReceiptPolicy();
  const storeApi = useAppStoreApi();
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [forwardOpen, setForwardOpen] = useState(false);
  const [forwardContactId, setForwardContactId] = useState<string | null>(null);
  const bulkActionsMeasureRef = useRef<HTMLDivElement>(null);
  const [topBulkActionCount, setTopBulkActionCount] = useState(4);
  const presentedIncomingByContactId = useRef(new Map<string, Set<string>>());

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
    // Selection belongs only to the currently rendered chat and must never
    // bleed into another conversation after navigation.
    messageActions.clearMessageSelection();
    messageActions.clearForwardSources();
  }, [resolvedContactId]);

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

  useEffect(() => {
    if (contact === null) return;
    const previouslyPresented = presentedIncomingByContactId.current.get(contact.contactId) ?? new Set<string>();
    const newlyPresented = conversation.messages
      .filter((message) => message.direction === "incoming" && !previouslyPresented.has(message.messageId))
      .map((message) => message.messageId);
    if (newlyPresented.length === 0) return;
    for (const messageId of newlyPresented) previouslyPresented.add(messageId);
    presentedIncomingByContactId.current.set(contact.contactId, previouslyPresented);
    // A local presentation is durable even while detached. The opt-in value
    // is sampled at this moment; later presence changes cannot create or
    // suppress a Read claim for an already displayed message.
    storeApi.getState().recordIncomingMessagesRead(contact.contactId, newlyPresented, receiptPolicy.sendReadReceipts);
  }, [contact, conversation.messages, receiptPolicy.sendReadReceipts, storeApi]);

  useLayoutEffect(() => {
    const measure = bulkActionsMeasureRef.current;
    if (measure === null || messageActions.selectedMessageIds.length === 0) {
      return;
    }
    const updatePlacement = (): void => {
      const gap = Number.parseFloat(getComputedStyle(measure).gap) || 0;
      const widths = Array.from(measure.children, (child) => child.getBoundingClientRect().width);
      let usedWidth = 0;
      let count = 0;
      for (const width of widths) {
        const nextWidth = count === 0 ? width : usedWidth + gap + width;
        if (count > 0 && nextWidth > measure.clientWidth) break;
        usedWidth = nextWidth;
        count += 1;
      }
      // Keep one action at the top even on an exceptionally narrow viewport;
      // the rest continue in the lower action row instead of being duplicated.
      setTopBulkActionCount(Math.max(1, count));
    };
    updatePlacement();
    const observer = new ResizeObserver(updatePlacement);
    observer.observe(measure);
    return () => { observer.disconnect(); };
  }, [messageActions.selectedMessageIds.length]);

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

  const sendBody = (body: string, previousUnavailableMessage?: MessageSummary, destination: ContactSummary = contact): void => {
    if (body === "" || identity.identity === null) {
      return;
    }
    setSendError(null);
    // Local projection and application identity are both fresh opaque values.
    // A live outer delivery ID is created later by the outbox runtime; a
    // forwarded body never inherits IDs or receipt state from its source.
    const createdAt = Date.now();
    const composition = composeOutgoingText({
      contactId: destination.contactId,
      body,
      createdAt: previousUnavailableMessage?.sentAt ?? createdAt,
      createId: createDeliveryID
    });
    const pendingMessage = composition.message;
    if (previousUnavailableMessage === undefined) {
      conversation.appendMessage(pendingMessage);
    } else if (!conversation.retryUnavailableMessage(destination.contactId, previousUnavailableMessage.messageId, pendingMessage)) {
      return;
    }

    const destinationPeerId = destination.peerId;
    const destinationHpkePublicKey = destination.hpkePublicKey;
    const destinationReachable = destinationPeerId !== null && destinationHpkePublicKey !== null;
    if (destinationReachable) {
      // The foreground outbox runtime is the sole generic-text sender, even
      // for the initial attempt. This keeps first sends and retries under the
      // same one-envelope ACK-gated drain. Queue admission is a local
      // user action: a cold volatile capability cache must not downgrade this
      // message into an unqueueable legacy live attempt.
      storeApi.getState().queueMessage({ messageId: pendingMessage.messageId, applicationMessageId: composition.applicationMessageId, contactId: destination.contactId, createdAt, nextAttemptAt: createdAt, attempts: 0, lastDeliveryId: null, deliveredAt: null });
    }
    const supportsGenericText = destinationPeerId !== null && peerSupportsChatText(destinationPeerId);
    if (destinationReachable && !supportsGenericText && hasAttachedRelaySession()) {
      // Capability control is the only live traffic allowed while optional
      // generic-text support is unknown. The already-persisted text waits for
      // its signed response; no legacy payload is silently emitted.
      void sendApplicationCapabilities({
        senderPeerId: identity.identity.peerId,
        recipientPeerId: destinationPeerId,
        recipientHpkePublicKey: destinationHpkePublicKey,
        attached: true
      }).then((result) => {
        storeApi.getState().recordTransportTrace(`outbox: capability_bootstrap_${result}`);
      }).catch(() => {
        storeApi.getState().recordTransportTrace("outbox: capability_bootstrap_failed");
      });
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

  const openForward = (messages: readonly MessageSummary[]): void => {
    // Service bubbles are local presentation facts rather than user text and
    // are deliberately never turned into a new endpoint message.
    const sourceIds = messages.filter((message) => message.direction !== "service").map((message) => message.messageId);
    if (sourceIds.length === 0) return;
    messageActions.setForwardSources(contact.contactId, sourceIds);
    setForwardContactId(null);
    setForwardOpen(true);
  };

  const deleteMessagesLocally = (messages: readonly MessageSummary[]): void => {
    conversation.deleteMessagesLocally(contact.contactId, messages.map((message) => message.messageId));
    messageActions.clearMessageSelection();
    messageActions.clearForwardSources();
  };

  const confirmForward = (): void => {
    const destination = contacts.contacts.find((candidate) => candidate.contactId === forwardContactId) ?? null;
    if (destination === null) return;
    const sources = messageActions.forwardSourceMessageIds
      .map((messageId) => conversation.messages.find((message) => message.messageId === messageId))
      .filter((message): message is MessageSummary => message !== undefined);
    for (const source of sources) sendBody(source.body, undefined, destination);
    messageActions.clearMessageSelection();
    messageActions.clearForwardSources();
    setForwardOpen(false);
    setForwardContactId(null);
  };

  const selectedMessages = conversation.messages.filter((message) => messageActions.selectedMessageIds.includes(message.messageId));
  const cancelMessageSelection = (): void => {
    messageActions.clearMessageSelection();
    messageActions.clearForwardSources();
  };

  const bulkActionItems = (): readonly React.JSX.Element[] => [
    <span className="pwa-chat-bulk-item pwa-chat-bulk-selection-count" key="selected-count">{messageActions.selectedMessageIds.length} selected</span>,
    <span className="pwa-chat-bulk-item" key="forward">
        <Button className="pwa-chat-bulk-action" icon={<ForwardOutlined />} onClick={() => { openForward(selectedMessages); }} size="small">Forward</Button>
    </span>,
    <span className="pwa-chat-bulk-item" key="delete">
        <Button className="pwa-chat-bulk-action" danger icon={<DeleteOutlined />} onClick={() => { deleteMessagesLocally(selectedMessages); }} size="small">Delete locally</Button>
    </span>,
    <span className="pwa-chat-bulk-item" key="cancel">
      <Button className="pwa-chat-bulk-action" onClick={cancelMessageSelection} size="small" type="text">Cancel</Button>
    </span>
  ];

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
      {messageActions.selectedMessageIds.length > 0 && (
        <>
          <div aria-hidden="true" className="pwa-chat-bulk-actions pwa-chat-bulk-actions-measure" ref={bulkActionsMeasureRef}>
            {bulkActionItems()}
          </div>
          <div aria-label="Selected message actions" className="pwa-chat-bulk-actions">
            {bulkActionItems().slice(0, topBulkActionCount)}
          </div>
        </>
      )}
      <MessageLog
        contactId={contact.contactId}
        emptyDescription="No messages yet."
        menuMessageId={messageActions.menuMessageId}
        messages={conversation.messages}
        onCloseMessageMenu={messageActions.closeMessageMenu}
        onOpenMessageMenu={(message) => { messageActions.openMessageMenu(contact.contactId, message.messageId); }}
        onRetryUnavailableMessage={retryUnavailableMessage}
        onToggleMessageSelection={(message) => { messageActions.toggleMessageSelection(contact.contactId, message.messageId); }}
        selectedMessageIds={messageActions.selectedMessageIds}
      />
      {messageActions.selectedMessageIds.length > 0 && topBulkActionCount < bulkActionItems().length && (
        <div aria-label="Selected message actions, continued" className="pwa-chat-bulk-actions pwa-chat-bulk-actions-bottom">
          {bulkActionItems().slice(topBulkActionCount)}
        </div>
      )}
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
      <Modal
        cancelText="Cancel"
        okButtonProps={{ disabled: forwardContactId === null }}
        okText="Forward"
        onCancel={() => {
          messageActions.clearForwardSources();
          setForwardOpen(false);
          setForwardContactId(null);
        }}
        onOk={confirmForward}
        open={forwardOpen}
        title={`Forward ${String(messageActions.forwardSourceMessageIds.length)} message${messageActions.forwardSourceMessageIds.length === 1 ? "" : "s"}`}
      >
        <p>Only the visible message text is forwarded. Delivery status, timestamps, and source metadata stay on this device.</p>
        <Select
          aria-label="Forward destination"
          onChange={(value: string) => { setForwardContactId(value); }}
          options={contacts.contacts.map((candidate) => ({ value: candidate.contactId, label: candidate.displayName }))}
          placeholder="Choose a contact"
          value={forwardContactId}
        />
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
