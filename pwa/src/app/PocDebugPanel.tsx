import { BugOutlined, CopyOutlined, DeleteOutlined, ReloadOutlined, StopOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { Button, Checkbox, Popconfirm, Select, Tag, Tooltip } from "antd";
import { useEffect, useMemo, useState } from "react";

import { browserPocBurstTimers, PocBurstRunner, type PocBurstProgress } from "./poc-burst.js";
import { deleteStoredMessageDeliveryTarget } from "../storage/message-delivery-target-store.js";
import { useAppStore } from "../state/StoreProvider.js";
import type { TransportTraceEntry } from "../state/slices/transport-slice.js";

const burstOptions = [4, 8, 16] as const;

const traceCategories = ["messages", "presence", "receipts", "outbox", "controls", "transport", "frames"] as const;
type TraceCategory = (typeof traceCategories)[number];

const defaultTraceCategories: TraceCategory[] = ["messages", "presence", "receipts", "outbox", "controls", "transport"];

const traceCategoryOptions: { label: string; value: TraceCategory }[] = [
  { label: "Messages", value: "messages" },
  { label: "Presence", value: "presence" },
  { label: "Receipts", value: "receipts" },
  { label: "Outbox", value: "outbox" },
  { label: "Controls", value: "controls" },
  { label: "Transport", value: "transport" },
  { label: "Frames", value: "frames" }
];

export function PocDebugPanel({ contactId, contactName, enabled, attachedRelayEndpoint, attachStatus, queuedCount, transportTrace, onBurstMessage, onRendezvous }: {
  readonly contactId: string;
  readonly contactName: string;
  readonly enabled: boolean;
  readonly attachedRelayEndpoint: string | null;
  readonly attachStatus: string;
  readonly queuedCount: number;
  readonly transportTrace: readonly TransportTraceEntry[];
  readonly onBurstMessage: (index: number, total: number) => void;
  readonly onRendezvous: () => void;
}): React.JSX.Element {
  const runner = useMemo(() => new PocBurstRunner(browserPocBurstTimers), []);
  const [burstCount, setBurstCount] = useState<(typeof burstOptions)[number]>(8);
  const [progress, setProgress] = useState<PocBurstProgress>({ sent: 0, total: 0, running: false });
  const [selectedTraceCategories, setSelectedTraceCategories] = useState<TraceCategory[]>(defaultTraceCategories);
  const outbox = useAppStore((state) => state.outbox);
  const settleOutboxMessage = useAppStore((state) => state.settleOutboxMessage);
  const clearLocalConversation = useAppStore((state) => state.clearLocalConversation);
  const recordTransportTrace = useAppStore((state) => state.recordTransportTrace);
  const { awaitingDeliveryCount, deliveredAwaitingReadCount } = useMemo(() => {
    const localOutbox = outbox.filter((entry) => entry.contactId === contactId);
    const awaiting = localOutbox.filter((entry) => entry.deliveredAt === null).length;
    return { awaitingDeliveryCount: awaiting, deliveredAwaitingReadCount: localOutbox.length - awaiting };
  }, [contactId, outbox]);
  const purgeableMessageIds = useMemo(() => purgeableOutboxMessageIds(outbox, contactId), [contactId, outbox]);

  useEffect(() => {
    runner.stop();
    setProgress({ sent: 0, total: 0, running: false });
  }, [contactId, runner]);
  useEffect(() => () => { runner.stop(); }, [runner]);

  const startBurst = (): void => {
    if (!enabled) return;
    const started = runner.start(burstCount, onBurstMessage, setProgress);
    if (started) setProgress({ sent: 1, total: burstCount, running: burstCount > 1 });
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
        <div><dt>Outbox</dt><dd>{String(queuedCount)} total · {String(awaitingDeliveryCount)} deliv · {String(deliveredAwaitingReadCount)} read</dd></div>
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
        <span className="pwa-poc-debug-progress">{progress.total === 0 ? "Ready" : `${String(progress.sent)}/${String(progress.total)} ${progress.running ? "queueing" : "queued"}`}</span>
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
      <Checkbox.Group
        aria-label="Trace categories"
        onChange={(values) => { setSelectedTraceCategories(values.filter(isTraceCategory)); }}
        options={traceCategoryOptions}
        value={selectedTraceCategories}
      />
      <ol aria-label="Recent local relay trace" className="pwa-poc-debug-trace">
        {recentTrace.length === 0 ? <li>No local events yet.</li> : recentTrace.map((entry) => {
          const category = traceCategory(entry.detail);
          return <li className={`is-${category}`} key={`${String(entry.at)}-${entry.detail}`}><time>{formatTime(entry.at)}</time> {entry.detail}</li>;
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

function formatTime(at: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(at);
}
