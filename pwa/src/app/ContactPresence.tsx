import { ReloadOutlined } from "@ant-design/icons";
import { Badge, Button, Tooltip } from "antd";

import { probeContactPresence } from "../connectivity/contact-presence-runtime.js";
import { hasAttachedRelaySession } from "../connectivity/relay-session.js";
import type { ContactSummary } from "../state/slices/contacts-slice.js";
import { useContactPresence, useContactTyping, useIdentity, useTransportStatus } from "../state/hooks.js";
import { useAppStoreApi } from "../state/StoreProvider.js";
import { ContactTyping } from "./ContactTyping.js";

export function ContactPresence({ contact }: { readonly contact: ContactSummary }): React.JSX.Element | null {
  const storeApi = useAppStoreApi();
  const identity = useIdentity();
  const transport = useTransportStatus();
  const { presence: presenceState } = useContactPresence(contact.contactId);
  const { expiresAt } = useContactTyping(contact.contactId);
  const canPing = transport.attachStatus === "attached" && identity.identity !== null && contact.peerId !== null && contact.hpkePublicKey !== null && hasAttachedRelaySession();

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
  const title = status === "available"
    ? presenceState.evidence === "encrypted_live_traffic"
      ? "Contact online (encrypted live traffic)"
      : "Contact online (encrypted pong)"
    : label;
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
          onClick={() => { void probeContactPresence(storeApi, contact.contactId); }}
          size="small"
          type="text"
        />
      </Tooltip>
    </span>
  );
}
