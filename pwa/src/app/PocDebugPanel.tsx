import { BugOutlined, CopyOutlined, DeleteOutlined, ReloadOutlined, StopOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { Button, Checkbox, Popconfirm, Select, Tag, Tooltip } from "antd";
import { useEffect, useMemo, useState } from "react";

import { browserPocBurstTimers, PocBurstRunner, type PocBurstProgress } from "./poc-burst.js";
import { clientMonitorCountBucket, clientMonitorOutboxItems, useClientMonitor } from "./client-monitor.js";
import { deleteStoredMessageDeliveryTarget } from "../storage/message-delivery-target-store.js";
import { useAppStore } from "../state/StoreProvider.js";
import type { TransportTraceEntry } from "../state/slices/transport-slice.js";

const burstOptions = [4, 8, 16] as const;

const traceCategories = ["messages", "presence", "receipts", "outbox", "controls", "transport", "frames"] as const;
type TraceCategory = (typeof traceCategories)[number];

const defaultTraceCategories: TraceCategory[] = ["messages", "presence", "receipts", "outbox", "controls", "transport"];
const traceCategoryPreferenceKey = "branch.pwa.poc.trace-categories/v1";

const traceCategoryOptions: { label: React.JSX.Element; value: TraceCategory }[] = traceCategories.map((category) => ({
  label: <span className={`pwa-poc-debug-filter is-${category}`}>{traceCategoryLabel(category)}</span>,
  value: category
}));

export function PocDebugPanel({ contactId, contactName, enabled, attachedRelayEndpoint, attachStatus, queuedCount, transportTrace, onBurstMessage, onRendezvous }: {
  readonly contactId: string;
  readonly contactName: string;
  readonly enabled: boolean;
  readonly attachedRelayEndpoint: string | null;
  readonly attachStatus: string;
  readonly queuedCount: number;
  readonly transportTrace: readonly TransportTraceEntry[];
  readonly onBurstMessage: (session: number, index: number, total: number) => void;
  readonly onRendezvous: () => void;
}): React.JSX.Element {
  const runner = useMemo(() => new PocBurstRunner(browserPocBurstTimers), []);
  const [burstCount, setBurstCount] = useState<(typeof burstOptions)[number]>(8);
  const [progress, setProgress] = useState<PocBurstProgress>({ session: 0, sent: 0, total: 0, running: false });
  const [selectedTraceCategories, setSelectedTraceCategories] = useState<TraceCategory[]>(loadTraceCategories);
  const outbox = useAppStore((state) => state.outbox);
  const identityStatus = useAppStore((state) => state.identityStatus);
  const routeStatus = useAppStore((state) => state.routeStatus);
  const contactDiscoveryAvailability = useAppStore((state) => state.contactDiscoveryAvailability);
  const contacts = useAppStore((state) => state.contacts);
  const contactPresenceById = useAppStore((state) => state.contactPresenceById);
  const readReceiptOutbox = useAppStore((state) => state.readReceiptOutbox);
  const inboundAttachmentOffersByPeerId = useAppStore((state) => state.inboundAttachmentOffersByPeerId);
  const settleOutboxMessage = useAppStore((state) => state.settleOutboxMessage);
  const clearLocalConversation = useAppStore((state) => state.clearLocalConversation);
  const recordTransportTrace = useAppStore((state) => state.recordTransportTrace);
  const monitorSnapshot = useMemo(() => ({
    identity: identityStatus,
    page: "chats" as const,
    route: routeStatus,
    attach: attachStatus as "idle" | "attaching" | "attached" | "error",
    relay: clientMonitorRelayLabel(attachedRelayEndpoint),
    discovery: contactDiscoveryAvailability,
    contacts: clientMonitorCountBucket(contacts.length),
    presence: clientMonitorCountBucket(Object.values(contactPresenceById).filter((presence) => presence.status !== "unknown").length),
    outbox: clientMonitorCountBucket(outbox.length),
    outbox_items: clientMonitorOutboxItems(outbox),
    read_work: clientMonitorCountBucket(readReceiptOutbox.filter((entry) => entry.receiptPending).length),
    attachments: clientMonitorCountBucket(Object.keys(inboundAttachmentOffersByPeerId).length)
  }), [attachStatus, attachedRelayEndpoint, contactDiscoveryAvailability, contactPresenceById, contacts.length, identityStatus, inboundAttachmentOffersByPeerId, outbox.length, readReceiptOutbox, routeStatus]);
  const clientMonitorStatus = useClientMonitor(transportTrace, selectedTraceCategories, monitorSnapshot);
  const { awaitingDeliveryCount, deliveredAwaitingReadCount } = useMemo(() => {
    const localOutbox = outbox.filter((entry) => entry.contactId === contactId);
    const awaiting = localOutbox.filter((entry) => entry.deliveredAt === null).length;
    return { awaitingDeliveryCount: awaiting, deliveredAwaitingReadCount: localOutbox.length - awaiting };
  }, [contactId, outbox]);
  const purgeableMessageIds = useMemo(() => purgeableOutboxMessageIds(outbox, contactId), [contactId, outbox]);

  useEffect(() => {
    runner.stop();
    setProgress({ session: 0, sent: 0, total: 0, running: false });
  }, [contactId, runner]);
  useEffect(() => () => { runner.stop(); }, [runner]);

  const startBurst = (): void => {
    if (!enabled) return;
    runner.start(burstCount, onBurstMessage, setProgress);
  };

  const stopBurst = (): void => { runner.stop(); };
  const purgeDelivered = (): void => {
    for (const messageId of purgeableMessageIds) {
      settleOutboxMessage(messageId);
      void deleteStoredMessageDeliveryTarget(messageId).catch(() => {});
    }
    if (purgeableMessageIds.length > 0) recordTransportTrace(`outbox: delivery_mapping_purged ${String(purgeableMessageIds.length)}`);
  };
  const resetChat = (): void => {
    clearLocalConversation(contactId);
    recordTransportTrace("outbox: local_chat_reset");
  };
  const copyTraceBuffer = (): void => {
    void navigator.clipboard.writeText(traceBufferText(transportTrace));
  };
  const recentTrace = transportTrace
    .filter((entry) => selectedTraceCategories.includes(traceCategory(entry.detail)))
    .reverse();

  return (
    <aside aria-label="PoC debug panel" className="pwa-poc-debug">
      <header className="pwa-poc-debug-heading">
        <BugOutlined /> <span>PoC debug</span>
        <Tooltip title="Copy local trace buffer">
          <Button aria-label="Copy local trace buffer" className="pwa-poc-debug-copy" disabled={transportTrace.length === 0} icon={<CopyOutlined />} onClick={copyTraceBuffer} size="small" type="text" />
        </Tooltip>
      </header>
      <dl className="pwa-poc-debug-status">
        <div><dt>Chat</dt><dd>{contactName}</dd></div>
        <div><dt>Relay</dt><dd><Tag color={attachStatus === "attached" ? "cyan" : "default"}>{attachStatus}</Tag></dd></div>
        <div className="pwa-poc-debug-endpoint"><dd title={attachedRelayEndpoint ?? undefined}>{attachedRelayEndpoint ?? "none"}</dd></div>
        <div>
          <dt>Outbox</dt>
          <dd className="pwa-poc-debug-outbox-status">
            <span className="pwa-poc-debug-outbox-stat is-total">{String(queuedCount)} total</span>
            <Tooltip title="Awaiting a signed Delivered receipt"><span className="pwa-poc-debug-outbox-stat is-delivery">{String(awaitingDeliveryCount)} →deliv</span></Tooltip>
            <Tooltip title="Delivered; awaiting a signed Read receipt"><span className="pwa-poc-debug-outbox-stat is-read">{String(deliveredAwaitingReadCount)} →read</span></Tooltip>
          </dd>
        </div>
      </dl>
      <div className="pwa-poc-debug-actions">
        <Select
          aria-label="PoC burst size"
          disabled={!enabled || progress.running}
          onChange={(value: (typeof burstOptions)[number]) => { setBurstCount(value); }}
          options={burstOptions.map((value) => ({ label: `${String(value)} messages`, value }))}
          size="small"
          value={burstCount}
        />
        <Button disabled={!enabled || progress.running} icon={<ThunderboltOutlined />} onClick={startBurst} size="small" type="primary">Burst</Button>
        <Tooltip title="Queue no further burst messages; existing outbox entries are unchanged.">
          <Button aria-label="Stop PoC burst" disabled={!progress.running} icon={<StopOutlined />} onClick={stopBurst} size="small" />
        </Tooltip>
      </div>
      <div className="pwa-poc-debug-actions">
        <Button disabled={!enabled} icon={<ReloadOutlined />} onClick={onRendezvous} size="small">Rendezvous</Button>
        <span className="pwa-poc-debug-progress">{progress.total === 0 ? "Ready" : `#${String(progress.session)} ${String(progress.sent)}/${String(progress.total)} ${progress.running ? "queueing" : "queued"}`}</span>
      </div>
      <div className="pwa-poc-debug-actions">
        <Popconfirm
          cancelText="Keep"
          description="This drops only this device's Delivered-to-Read mapping. It never marks Read or affects the peer; a later signed Read will be shown as unmatched."
          okButtonProps={{ danger: true }}
          okText="Drop local mapping"
          onConfirm={purgeDelivered}
          title={`Drop ${String(purgeableMessageIds.length)} local delivery mappings?`}
        >
          <Button danger disabled={purgeableMessageIds.length === 0} icon={<DeleteOutlined />} size="small">Purge</Button>
        </Popconfirm>
        <Popconfirm
          cancelText="Keep"
          description="This device only: removes this chat's messages, local outbox, Read work and delivery mappings. Contact, identity and relay stay intact."
          okButtonProps={{ danger: true }}
          okText="Reset local chat"
          onConfirm={resetChat}
          title={`Reset all local test messages with ${contactName}?`}
        >
          <Button danger icon={<DeleteOutlined />} size="small">Reset chat</Button>
        </Popconfirm>
      </div>
      <p className="pwa-poc-debug-note">Burst is local pacing into the normal outbox; it creates no special relay traffic or retry policy.</p>
      <p className="pwa-poc-debug-monitor-status">Client monitor: {clientMonitorStatus}. Automatic redacted development reports.</p>
      <Checkbox.Group
        aria-label="Trace categories"
        onChange={(values) => {
          const selected = values.filter(isTraceCategory);
          setSelectedTraceCategories(selected);
          saveTraceCategories(selected);
        }}
        options={traceCategoryOptions}
        value={selectedTraceCategories}
      />
      <ol aria-label="Recent local relay trace" className="pwa-poc-debug-trace">
        {recentTrace.length === 0 ? <li>No local events yet.</li> : recentTrace.map((entry) => {
          const category = traceCategory(entry.detail);
          return <li className={`is-${category}`} key={`${String(entry.at)}-${entry.detail}`}><span>{entry.detail}</span><time>{formatTime(entry.at)}</time></li>;
        })}
      </ol>
    </aside>
  );
}

export function traceCategory(detail: string): TraceCategory {
  if (detail.startsWith("outbound frame:") || detail === "incoming envelope: received" || detail === "incoming envelope: opened") return "frames";
  if (detail.startsWith("delivery receipt:")) return "receipts";
  if (detail.startsWith("outbox:")) return "outbox";
  if (detail.includes("presence_") || detail.startsWith("typing control:")) return "presence";
  if (detail === "incoming envelope: message" || detail === "incoming envelope: duplicate message") return "messages";
  if (detail.startsWith("application capabilities:") || detail.startsWith("image capabilities:") || detail.startsWith("rtc ") || detail.startsWith("attachment:") || detail.startsWith("contact probe:")) return "controls";
  return "transport";
}

export function traceBufferText(entries: readonly TransportTraceEntry[]): string {
  return entries.map((entry) => `${formatTime(entry.at)} ${entry.detail}`).join("\n");
}

export function purgeableOutboxMessageIds(entries: readonly { readonly messageId: string; readonly contactId: string; readonly deliveredAt: number | null }[], contactId: string): readonly string[] {
  return entries.filter((entry) => entry.contactId === contactId && entry.deliveredAt !== null).map((entry) => entry.messageId);
}

function isTraceCategory(value: unknown): value is TraceCategory {
  return typeof value === "string" && (traceCategories as readonly string[]).includes(value);
}

function traceCategoryLabel(category: TraceCategory): string {
  return category.charAt(0).toUpperCase() + category.slice(1);
}

function loadTraceCategories(): TraceCategory[] {
  if (typeof window === "undefined") return defaultTraceCategories;
  try {
    const stored = window.localStorage.getItem(traceCategoryPreferenceKey);
    if (stored === null) return defaultTraceCategories;
    const decoded: unknown = JSON.parse(stored);
    return Array.isArray(decoded) ? decoded.filter(isTraceCategory) : defaultTraceCategories;
  } catch {
    return defaultTraceCategories;
  }
}

function saveTraceCategories(categories: readonly TraceCategory[]): void {
  try {
    window.localStorage.setItem(traceCategoryPreferenceKey, JSON.stringify(categories));
  } catch {
    // Developer filter preferences are optional local UI state.
  }
}

function formatTime(at: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(at);
}

function clientMonitorRelayLabel(endpoint: string | null): "none" | `relay${number}` {
  if (endpoint === null) return "none";
  try {
    const relay = new URL(endpoint).hostname.match(/^relay(\d{2})\./u)?.[1];
    return relay === undefined ? "none" : `relay${relay}` as `relay${number}`;
  } catch {
    return "none";
  }
}
