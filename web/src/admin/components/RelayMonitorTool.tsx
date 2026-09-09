import { DownloadOutlined, ReloadOutlined, StopOutlined } from "@ant-design/icons";
import { Button, Input, Space, Statistic, Table, Tag, type TableColumnsType } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { downloadBytes } from "../browser-files.js";
import { githubBundleFilenameForRelay } from "../defaults.js";
import { makeLiveGitHubDropInBundleFromWrapper } from "../github-dropin.js";
import { fetchRelayMonitorObservations, type RelayMonitorObservation } from "../relay-monitor.js";
import { useAdminStore, type StatusClass } from "../store.js";

const expectedRelays = [
  { id: "relay01", endpoint: "wss://relay01.undoo.ru:443/relay/v0" },
  { id: "relay02", endpoint: "wss://relay02.undoo.ru:443/relay/v0" },
  { id: "relay04", endpoint: "wss://relay04.undoo.ru:443/relay/v0" },
  { id: "relay05", endpoint: "wss://relay05.undoo.ru:443/relay/v0" }
] as const;

export function RelayMonitorTool(): React.JSX.Element {
  const abortRef = useRef<AbortController | null>(null);
  const [search, setSearch] = useState("");
  const [bundleRelayId, setBundleRelayId] = useState<string | null>(null);
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
  const visibleRows = useMemo(() => filterRows(rows, search), [rows, search]);
  const generateGitHubBundle = useCallback(async (row: RelayInventoryRow): Promise<void> => {
    const beacon = row.observation?.bootstrap_beacon;
    if (beacon === undefined) {
      setRelayMonitorStatus(`relay ${row.id} has no reported bootstrap.beacon yet`, "status-warn");
      return;
    }
    if (bootstrapBeaconExpired(beacon.expires_at)) {
      setRelayMonitorStatus(`relay ${row.id} bootstrap.beacon expired`, "status-bad");
      return;
    }
    setBundleRelayId(row.id);
    setRelayMonitorStatus(`generating GitHub bundle for ${row.id}`, "status-warn");
    try {
      const bundle = await makeLiveGitHubDropInBundleFromWrapper(beacon.wrapper, "", Math.floor(Date.now() / 1000));
      downloadBytes(bundle.archive, githubBundleFilenameForRelay(row.id), "application/zip");
      setRelayMonitorStatus(`GitHub bundle generated for ${row.id}`, "status-good");
    } catch (error) {
      setRelayMonitorStatus(errorMessage(error), "status-bad");
    } finally {
      setBundleRelayId(null);
    }
  }, [setRelayMonitorStatus]);
  const columns = useMemo<TableColumnsType<RelayInventoryRow>>(() => [
    {
      title: "Relay",
      dataIndex: "id",
      key: "id",
      sorter: (left, right) => left.id.localeCompare(right.id),
      render: (value: string) => <strong>{value}</strong>
    },
    {
      title: "Freshness",
      key: "freshness",
      sorter: (left, right) => freshnessRank(left.observation) - freshnessRank(right.observation),
      render: (_, row) => (
        <Tag color={freshnessColor(row.observation)}>
          {row.observation === null ? "missing" : row.observation.stale ? "stale" : "fresh"}
        </Tag>
      )
    },
    {
      title: "Readiness",
      key: "readiness",
      sorter: (left, right) => readinessText(left.observation).localeCompare(readinessText(right.observation)),
      render: (_, row) => <Tag color={readinessColor(row.observation)}>{readinessText(row.observation)}</Tag>
    },
    {
      title: "Endpoint",
      key: "endpoint",
      sorter: (left, right) => endpointText(left).localeCompare(endpointText(right)),
      render: (_, row) => <span className="mono-cell">{endpointText(row)}</span>
    },
    {
      title: "Last seen",
      key: "lastSeen",
      sorter: (left, right) => timestamp(left.observation?.last_seen_at) - timestamp(right.observation?.last_seen_at),
      render: (_, row) => row.observation === null ? "-" : formatTime(row.observation.last_seen_at)
    },
    {
      title: "Counters",
      key: "counters",
      render: (_, row) => row.observation === null ? "-" : counterText(row.observation)
    },
    {
      title: "Federation",
      key: "federation",
      sorter: (left, right) => federationRank(left.observation) - federationRank(right.observation),
      render: (_, row) => federationText(row.observation)
    },
    {
      title: "Build",
      key: "build",
      sorter: (left, right) => buildText(left.observation).localeCompare(buildText(right.observation)),
      render: (_, row) => buildText(row.observation)
    },
    {
      title: "Actions",
      key: "actions",
      render: (_, row) => (
        <Button
          icon={<DownloadOutlined />}
          disabled={!canGenerateGitHubBundle(row) || bundleRelayId !== null}
          loading={bundleRelayId === row.id}
          onClick={() => { void generateGitHubBundle(row); }}
        >
          GitHub bundle
        </Button>
      )
    }
  ], [bundleRelayId, generateGitHubBundle]);

  return (
    <section className="relay-monitor-layout" data-panel="relays" aria-label="Relay inventory">
      <section className="panel control-panel relay-monitor-summary" aria-label="Relay inventory controls">
        <div className="relay-monitor-controls">
          <div className="control-row">
            <label htmlFor="relay-monitor-admin-url">MASTER admin URL</label>
            <Input
              id="relay-monitor-admin-url"
              name="relay-monitor-admin-url"
              type="text"
              value={relayMonitor.adminBaseUrl}
              onChange={(event) => { setRelayMonitorAdminBaseUrl(event.currentTarget.value); }}
            />
          </div>
          <div className="control-row">
            <label htmlFor="relay-monitor-admin-token">Admin token</label>
            <Input.Password
              id="relay-monitor-admin-token"
              name="relay-monitor-admin-token"
              value={relayMonitor.adminToken}
              onChange={(event) => { setRelayMonitorAdminToken(event.currentTarget.value); }}
            />
          </div>
          <Space className="relay-monitor-actions" wrap>
            <Button icon={<ReloadOutlined />} type="primary" disabled={relayMonitor.running} onClick={() => { void refresh(); }}>
              Refresh
            </Button>
            <Button icon={<StopOutlined />} disabled={!relayMonitor.running} onClick={() => { abortRef.current?.abort(); }}>
              Cancel
            </Button>
          </Space>
          <p className={relayMonitor.statusClass}>{relayMonitor.status}</p>
        </div>
        <dl className="diagnostics relay-monitor-diagnostics">
          <div>
            <Statistic title="Observed" value={relayMonitor.observations.length} />
          </div>
          <div>
            <Statistic title="Fresh" value={relayMonitor.observations.filter((observation) => !observation.stale).length} />
          </div>
          <div>
            <Statistic title="Updated" value={relayMonitor.lastRefreshAt === null ? "-" : formatTime(relayMonitor.lastRefreshAt)} />
          </div>
        </dl>
      </section>

      <section className="panel output-panel relay-monitor-results" aria-label="Relay inventory results">
        <Input.Search
          allowClear
          placeholder="Search relay, endpoint, readiness"
          value={search}
          onChange={(event) => { setSearch(event.currentTarget.value); }}
        />
        <Table
          columns={columns}
          dataSource={visibleRows}
          pagination={{ pageSize: 8, showSizeChanger: true }}
          rowClassName={(row) => row.observation === null ? "is-missing" : ""}
          rowKey="id"
          scroll={{ x: 1320 }}
          size="small"
        />
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

function filterRows(rows: readonly RelayInventoryRow[], query: string): readonly RelayInventoryRow[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return rows;
  }
  return rows.filter((row) => [
    row.id,
    endpointText(row),
    readinessText(row.observation),
    row.observation === null ? "missing" : row.observation.stale ? "stale" : "fresh",
    buildText(row.observation),
    federationSearchText(row.observation)
  ].some((value) => value.toLowerCase().includes(needle)));
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

function counterText(observation: RelayMonitorObservation): string {
  return [
    `sessions ${String(observation.snapshot.sessions_active)}`,
    `routes ${String(observation.snapshot.routes_active)}`,
    `presence ${String(observation.snapshot.presence_active)}`,
    `queue ${String(observation.snapshot.queue_depth)}`
  ].join(" / ");
}

function federationText(observation: RelayMonitorObservation | null): ReactNode {
  const links = observation?.federation ?? [];
  const carrier = observation?.federation_carrier;
  if (links.length === 0 && carrier === undefined) {
    return "-";
  }
  return (
    <Space wrap size={[4, 4]}>
      {carrier === undefined ? null : (
        <Tag color={carrier.state === "ready" ? "cyan" : "volcano"}>
          {carrier.carrier} {carrier.state}{carrier.last_reason === undefined ? "" : ` / ${carrier.last_reason}`}{` / candidates ${String(carrier.candidate_count)}`}
        </Tag>
      )}
      {links.map((link) => (
        <Tag key={link.peer_endpoint} color={federationColor(link.state)}>
          {federationShortEndpoint(link.peer_endpoint)} {link.state}{link.last_reason === undefined ? "" : ` / ${link.last_reason}`}
        </Tag>
      ))}
    </Space>
  );
}

function federationSearchText(observation: RelayMonitorObservation | null): string {
  const links = (observation?.federation ?? [])
    .map((link) => [
      link.peer_relay_id ?? "",
      link.peer_endpoint,
      link.state,
      link.last_reason ?? ""
    ].join(" "))
    .join(" ");
  const carrier = observation?.federation_carrier;
  return [links, carrier?.carrier ?? "", carrier?.state ?? "", carrier?.last_reason ?? ""].join(" ");
}

function federationRank(observation: RelayMonitorObservation | null): number {
  const links = observation?.federation ?? [];
  if (links.some((link) => link.state === "reachable")) {
    return 2;
  }
  if (links.some((link) => link.state === "unreachable")) {
    return 1;
  }
  if (observation?.federation_carrier?.state === "unavailable") {
    return 1;
  }
  return 0;
}

function federationColor(state: "configured" | "reachable" | "unreachable"): string {
  switch (state) {
    case "reachable":
      return "green";
    case "unreachable":
      return "red";
    case "configured":
      return "blue";
  }
}

function federationShortEndpoint(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return endpoint;
  }
}

function endpointText(row: RelayInventoryRow): string {
  return row.observation?.public_endpoint ?? row.endpoint;
}

function readinessText(observation: RelayMonitorObservation | null): string {
  return observation?.snapshot.readiness ?? "-";
}

function buildText(observation: RelayMonitorObservation | null): string {
  return observation === null ? "-" : `${observation.snapshot.service_name} ${observation.snapshot.service_version}`;
}

function canGenerateGitHubBundle(row: RelayInventoryRow): boolean {
  const beacon = row.observation?.bootstrap_beacon;
  return beacon !== undefined && !bootstrapBeaconExpired(beacon.expires_at);
}

function bootstrapBeaconExpired(expiresAt: number): boolean {
  return expiresAt <= Math.floor(Date.now() / 1000);
}

function timestamp(value: string | undefined): number {
  return value === undefined ? 0 : Date.parse(value);
}

function freshnessRank(observation: RelayMonitorObservation | null): number {
  if (observation === null) {
    return 0;
  }
  return observation.stale ? 1 : 2;
}

function freshnessColor(observation: RelayMonitorObservation | null): string {
  if (observation === null || observation.stale) {
    return "gold";
  }
  return "green";
}

function readinessColor(observation: RelayMonitorObservation | null): string {
  switch (observation?.snapshot.readiness) {
    case "ready":
      return "green";
    case "degraded":
      return "gold";
    case "not_ready":
      return "red";
    default:
      return "default";
  }
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "relay monitor refresh failed";
}
