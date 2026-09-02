import { useCallback, useEffect, useMemo, useRef } from "react";

import { fetchRelayMonitorObservations, type RelayMonitorObservation } from "../relay-monitor.js";
import { useAdminStore, type StatusClass } from "../store.js";

const expectedRelays = [
  { id: "relay01", endpoint: "wss://relay01.undoo.ru:443/relay/v0" },
  { id: "relay02", endpoint: "wss://relay02.undoo.ru:443/relay/v0" }
] as const;

export function RelayMonitorTool(): React.JSX.Element {
  const abortRef = useRef<AbortController | null>(null);
  const relayMonitor = useAdminStore((state) => state.relayMonitor);
  const setRelayMonitorAdminBaseUrl = useAdminStore((state) => state.setRelayMonitorAdminBaseUrl);
  const setRelayMonitorAdminToken = useAdminStore((state) => state.setRelayMonitorAdminToken);
  const setRelayMonitorRunning = useAdminStore((state) => state.setRelayMonitorRunning);
  const setRelayMonitorObservations = useAdminStore((state) => state.setRelayMonitorObservations);
  const setRelayMonitorStatus = useAdminStore((state) => state.setRelayMonitorStatus);

  const refresh = useCallback(async (): Promise<void> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setRelayMonitorRunning(true);
    setRelayMonitorStatus("refreshing relay inventory", "status-warn");
    try {
      const observations = await fetchRelayMonitorObservations({
        adminBaseUrl: relayMonitor.adminBaseUrl,
        adminToken: relayMonitor.adminToken,
        fetcher: (input, init) => fetch(input, { ...init, signal: controller.signal })
      });
      if (abortRef.current !== controller) {
        return;
      }
      setRelayMonitorObservations(observations, new Date().toISOString());
      setRelayMonitorStatus(statusText(observations), statusClass(observations));
    } catch (error) {
      if (abortRef.current !== controller) {
        return;
      }
      setRelayMonitorStatus(controller.signal.aborted ? "cancelled" : errorMessage(error), controller.signal.aborted ? "status-warn" : "status-bad");
    } finally {
      if (abortRef.current === controller) {
        setRelayMonitorRunning(false);
      }
    }
  }, [
    relayMonitor.adminBaseUrl,
    relayMonitor.adminToken,
    setRelayMonitorObservations,
    setRelayMonitorRunning,
    setRelayMonitorStatus
  ]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const rows = useMemo(() => inventoryRows(relayMonitor.observations), [relayMonitor.observations]);

  return (
    <section className="tool-grid is-active relay-monitor-tool" data-panel="relays" aria-label="Relay inventory">
      <section className="panel control-panel relay-monitor-summary" aria-label="Relay inventory controls">
        <div className="control-row">
          <label htmlFor="relay-monitor-admin-url">MASTER admin URL</label>
          <input
            id="relay-monitor-admin-url"
            name="relay-monitor-admin-url"
            type="text"
            value={relayMonitor.adminBaseUrl}
            onChange={(event) => { setRelayMonitorAdminBaseUrl(event.currentTarget.value); }}
          />
        </div>
        <div className="control-row">
          <label htmlFor="relay-monitor-admin-token">Admin token</label>
          <input
            id="relay-monitor-admin-token"
            name="relay-monitor-admin-token"
            type="password"
            value={relayMonitor.adminToken}
            onChange={(event) => { setRelayMonitorAdminToken(event.currentTarget.value); }}
          />
        </div>
        <div className="button-row">
          <button type="button" disabled={relayMonitor.running} onClick={() => { void refresh(); }}>
            Refresh
          </button>
          <button type="button" disabled={!relayMonitor.running} onClick={() => { abortRef.current?.abort(); }}>
            Cancel
          </button>
        </div>
        <p className={relayMonitor.statusClass}>{relayMonitor.status}</p>
        <dl className="diagnostics relay-monitor-diagnostics">
          <div>
            <dt>Observed</dt>
            <dd>{String(relayMonitor.observations.length)}</dd>
          </div>
          <div>
            <dt>Fresh</dt>
            <dd>{String(relayMonitor.observations.filter((observation) => !observation.stale).length)}</dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>{relayMonitor.lastRefreshAt === null ? "-" : formatTime(relayMonitor.lastRefreshAt)}</dd>
          </div>
        </dl>
      </section>

      <section className="panel output-panel relay-monitor-results" aria-label="Relay inventory results">
        <table>
          <thead>
            <tr>
              <th>Relay</th>
              <th>Freshness</th>
              <th>Readiness</th>
              <th>Endpoint</th>
              <th>Last seen</th>
              <th>Counters</th>
              <th>Build</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className={row.observation === null ? "is-missing" : undefined}>
                <td><strong>{row.id}</strong></td>
                <td className={rowClass(row.observation)}>{row.observation === null ? "missing" : row.observation.stale ? "stale" : "fresh"}</td>
                <td>{row.observation?.snapshot.readiness ?? "-"}</td>
                <td>{row.observation?.public_endpoint ?? row.endpoint}</td>
                <td>{row.observation === null ? "-" : formatTime(row.observation.last_seen_at)}</td>
                <td>{row.observation === null ? "-" : counterText(row.observation)}</td>
                <td>{row.observation === null ? "-" : `${row.observation.snapshot.service_name} ${row.observation.snapshot.service_version}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </section>
  );
}

interface RelayInventoryRow {
  readonly id: string;
  readonly endpoint: string;
  readonly observation: RelayMonitorObservation | null;
}

function inventoryRows(observations: readonly RelayMonitorObservation[]): readonly RelayInventoryRow[] {
  const byID = new Map(observations.map((observation) => [observation.relay_id, observation]));
  const expected = expectedRelays.map((relay) => ({
    id: relay.id,
    endpoint: relay.endpoint,
    observation: byID.get(relay.id) ?? null
  }));
  const additional = observations
    .filter((observation) => !expectedRelays.some((relay) => relay.id === observation.relay_id))
    .map((observation) => ({
      id: observation.relay_id,
      endpoint: observation.public_endpoint,
      observation
    }));
  return [...expected, ...additional];
}

function statusText(observations: readonly RelayMonitorObservation[]): string {
  if (observations.length === 0) {
    return "no relay reports";
  }
  const staleCount = observations.filter((observation) => observation.stale).length;
  const notReadyCount = observations.filter((observation) => observation.snapshot.readiness === "not_ready").length;
  if (notReadyCount > 0) {
    return `${String(observations.length)} observed; ${String(notReadyCount)} not ready`;
  }
  if (staleCount > 0) {
    return `${String(observations.length)} observed; ${String(staleCount)} stale`;
  }
  return `${String(observations.length)} observed; all fresh`;
}

function statusClass(observations: readonly RelayMonitorObservation[]): StatusClass {
  if (observations.some((observation) => observation.snapshot.readiness === "not_ready")) {
    return "status-bad";
  }
  if (observations.length === 0 || observations.some((observation) => observation.stale || observation.snapshot.readiness === "degraded")) {
    return "status-warn";
  }
  return "status-good";
}

function rowClass(observation: RelayMonitorObservation | null): StatusClass {
  if (observation === null || observation.stale || observation.snapshot.readiness === "degraded") {
    return "status-warn";
  }
  if (observation.snapshot.readiness === "not_ready") {
    return "status-bad";
  }
  return "status-good";
}

function counterText(observation: RelayMonitorObservation): string {
  return [
    `sessions ${String(observation.snapshot.sessions_active)}`,
    `routes ${String(observation.snapshot.routes_active)}`,
    `presence ${String(observation.snapshot.presence_active)}`,
    `queue ${String(observation.snapshot.queue_depth)}`
  ].join(" / ");
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "relay monitor refresh failed";
}
