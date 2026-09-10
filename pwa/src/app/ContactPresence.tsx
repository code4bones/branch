import { ReloadOutlined } from "@ant-design/icons";
import { Badge, Button, Tooltip } from "antd";
import { useCallback, useEffect } from "react";

import { sendPresencePing } from "../connectivity/seal-and-send.js";
import { hasAttachedRelaySession } from "../connectivity/relay-session.js";
import type { ContactSummary } from "../state/slices/contacts-slice.js";
import { useContactPresence, useContactTyping, useIdentity, useTransportStatus } from "../state/hooks.js";
import { ContactTyping } from "./ContactTyping.js";

const presenceRenewIntervalMs = 20_000;
const presencePingTimeoutMs = 6_000;
const presenceAvailableTtlMs = 30_000;

export function ContactPresence({ contact }: { readonly contact: ContactSummary }): React.JSX.Element | null {
  const identity = useIdentity();
  const transport = useTransportStatus();
  const {
    presence: presenceState,
    beginContactPresencePing,
    expireContactPresencePing,
    expireContactPresence
  } = useContactPresence(contact.contactId);
  const { expiresAt } = useContactTyping(contact.contactId);
  const canPing = transport.attachStatus === "attached" && identity.identity !== null && contact.peerId !== null && contact.hpkePublicKey !== null && hasAttachedRelaySession();

  const ping = useCallback((): void => {
    const localIdentity = identity.identity;
    const peerId = contact.peerId;
    const hpkePublicKey = contact.hpkePublicKey;
    if (localIdentity === null || peerId === null || hpkePublicKey === null || !hasAttachedRelaySession()) {
      return;
    }
    void sendPresencePing({
      senderPeerId: localIdentity.peerId,
      recipientPeerId: peerId,
      recipientHpkePublicKey: hpkePublicKey
    }).then((pingId) => {
      beginContactPresencePing(contact.contactId, pingId);
    }).catch(() => {
      // No relay queue exists for presence controls. The previous result is
      // allowed to expire naturally rather than being relabelled offline.
    });
  }, [beginContactPresencePing, contact.contactId, contact.hpkePublicKey, contact.peerId, identity.identity, transport.attachStatus]);

  useEffect(() => {
    if (!canPing) {
      return undefined;
    }
    ping();
    const timer = setInterval(ping, presenceRenewIntervalMs);
    return () => { clearInterval(timer); };
  }, [canPing, ping]);

  useEffect(() => {
    const pingId = presenceState.pendingPingId;
    if (pingId === null) {
      return undefined;
    }
    const timer = setTimeout(() => {
      expireContactPresencePing(contact.contactId, pingId);
    }, presencePingTimeoutMs);
    return () => { clearTimeout(timer); };
  }, [contact.contactId, expireContactPresencePing, presenceState.pendingPingId]);

  useEffect(() => {
    if (presenceState.status === "unknown") {
      return undefined;
    }
    const ttl = presenceState.status === "checking" ? presencePingTimeoutMs : presenceAvailableTtlMs;
    const delay = Math.max(0, ttl - (Date.now() - presenceState.updatedAt));
    const timer = setTimeout(() => {
      expireContactPresence(contact.contactId, presenceState.updatedAt);
    }, delay);
    return () => { clearTimeout(timer); };
  }, [contact.contactId, expireContactPresence, presenceState.status, presenceState.updatedAt]);

  if (contact.peerId === null || contact.hpkePublicKey === null) {
    return null;
  }
  if (expiresAt !== null) {
    return <ContactTyping contactId={contact.contactId} variant="header" />;
  }
  // Presence is a bounded proof about the contact, not a projection of this
  // tab's relay attachment. Losing our local route disables new probes but
  // cannot revoke a pong that remains valid inside its explicit TTL.
  const status = presenceState.status;
  const label = status === "available"
    ? "online"
    : status === "checking"
      ? "Checking contact"
      : "Presence unknown";
  const title = status === "available" ? "Contact online (encrypted pong)" : label;
  const badgeStatus = status === "available" ? "success" : status === "checking" ? "processing" : "default";

  return (
    <span className="pwa-contact-presence">
      <Tooltip title={title}><Badge status={badgeStatus} text={label} /></Tooltip>
      <Tooltip title="Ping contact">
        <Button
          aria-label="Ping contact"
          disabled={!canPing}
          icon={<ReloadOutlined />}
          loading={status === "checking"}
          onClick={ping}
          size="small"
          type="text"
        />
      </Tooltip>
    </span>
  );
}
