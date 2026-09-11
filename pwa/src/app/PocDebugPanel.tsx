import { BugOutlined, ReloadOutlined, StopOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { Button, Select, Tag, Tooltip } from "antd";
import { useEffect, useMemo, useState } from "react";

import { browserPocBurstTimers, PocBurstRunner, type PocBurstProgress } from "./poc-burst.js";
import type { TransportTraceEntry } from "../state/slices/transport-slice.js";

const burstOptions = [4, 8, 16] as const;

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
  const recentTrace = transportTrace.slice(-8).reverse();

  return (
    <aside aria-label="PoC debug panel" className="pwa-poc-debug">
      <header className="pwa-poc-debug-heading"><BugOutlined /> <span>PoC debug</span></header>
      <dl className="pwa-poc-debug-status">
        <div><dt>Chat</dt><dd>{contactName}</dd></div>
        <div><dt>Relay</dt><dd><Tag color={attachStatus === "attached" ? "cyan" : "default"}>{attachStatus}</Tag></dd></div>
        <div><dt>Attached</dt><dd title={attachedRelayEndpoint ?? undefined}>{attachedRelayEndpoint ?? "none"}</dd></div>
        <div><dt>Outbox</dt><dd>{String(queuedCount)} queued</dd></div>
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
      <p className="pwa-poc-debug-note">Burst is local pacing into the normal outbox; it creates no special relay traffic or retry policy.</p>
      <ol aria-label="Recent local relay trace" className="pwa-poc-debug-trace">
        {recentTrace.length === 0 ? <li>No local events yet.</li> : recentTrace.map((entry) => (
          <li key={`${String(entry.at)}-${entry.detail}`}><time>{formatTime(entry.at)}</time> {entry.detail}</li>
        ))}
      </ol>
    </aside>
  );
}

function formatTime(at: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(at);
}
