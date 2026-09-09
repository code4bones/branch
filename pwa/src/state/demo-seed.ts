import type { ContactSummary } from "./slices/contacts-slice.js";
import type { MessageSummary } from "./slices/conversations-slice.js";

// Placeholder demo data so the messenger layout has something to show before
// real discovery/contacts and protocol wiring land (see the shared-package
// facade work tracked in Marrow). Safe to delete once contacts and messages
// are populated from the real client core instead.

export const demoContacts: readonly ContactSummary[] = [
  { contactId: "demo-ribbon-bearer", displayName: "Ribbon Bearer", peerId: null, hpkePublicKey: null, lastRouteHint: null },
  { contactId: "demo-relay-operator", displayName: "Relay Operator", peerId: null, hpkePublicKey: null, lastRouteHint: null },
  { contactId: "demo-carrier-hop", displayName: "Carrier Hop Test", peerId: null, hpkePublicKey: null, lastRouteHint: null }
];

const now = Date.now();
const minutes = 60 * 1000;
const hours = 60 * minutes;

export const demoMessages: readonly MessageSummary[] = [
  {
    messageId: "demo-msg-1",
    contactId: "demo-ribbon-bearer",
    direction: "incoming",
    body: "Beacon looks fresh, relay endpoint responded.",
    sentAt: now - 6 * minutes,
    deliveryState: "received"
  },
  {
    messageId: "demo-msg-2",
    contactId: "demo-ribbon-bearer",
    direction: "outgoing",
    body: "Good, attaching the test pair now.",
    sentAt: now - 5 * minutes,
    deliveryState: "relayed"
  },
  {
    messageId: "demo-msg-3",
    contactId: "demo-relay-operator",
    direction: "incoming",
    body: "relay02 origin allowlist deployed, retry when ready.",
    sentAt: now - 3 * hours,
    deliveryState: "received"
  },
  {
    messageId: "demo-msg-4",
    contactId: "demo-carrier-hop",
    direction: "incoming",
    body: "Carrier hop PoC finished, no durable state left behind.",
    sentAt: now - 26 * hours,
    deliveryState: "received"
  }
];
