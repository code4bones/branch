import { ApiOutlined, BranchesOutlined, PlayCircleOutlined, ReloadOutlined, StopOutlined, SyncOutlined } from "@ant-design/icons";
import { Button, Input, Select, Space, Statistic, Table, Tag, type TableColumnsType } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { discoverClientBootstrapBeacons } from "@code4bones/branch-core/discovery/client.js";
import type { CarrierHoppingTraceEvent, CarrierHoppingTraceStatus } from "@code4bones/branch-core/connectivity/carrier-hopping-poc.js";
import {
  createGitHubSearchCarrier,
  gitHubReportsFromCarrierReports,
  mergeGitHubDiscoveryReports,
  type GitHubDiscoveryResult,
  type GitHubValidatedRecord
} from "@code4bones/branch-core/discovery/github.js";
import { useAdminStore } from "../store.js";
import { useSameRelayTransportLab } from "../use-same-relay-transport-lab.js";

export function ClientTool(): React.JSX.Element {
  const abortRef = useRef<AbortController | null>(null);
  const [resultSearch, setResultSearch] = useState("");
  const [traceSearch, setTraceSearch] = useState("");
  const client = useAdminStore((state) => state.client);
  const setClientDiscoveryRunning = useAdminStore((state) => state.setClientDiscoveryRunning);
  const setClientDiscoveryResults = useAdminStore((state) => state.setClientDiscoveryResults);
  const setClientDiscoveryStatus = useAdminStore((state) => state.setClientDiscoveryStatus);
  const setClientManualRouteField = useAdminStore((state) => state.setClientManualRouteField);
  const setClientRouteMode = useAdminStore((state) => state.setClientRouteMode);
  const transport = useSameRelayTransportLab();

  const runDiscovery = useCallback(async (): Promise<void> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setClientDiscoveryRunning(true);
    setClientDiscoveryResults([], null, false);
    setClientDiscoveryStatus("searching GitHub repository locator", "status-warn");
    try {
      const discovery = await discoverClientBootstrapBeacons({
        carrier: createGitHubSearchCarrier(),
        primaryQuery: client.discoveryQuery,
        fallbackQuery: null,
        includeFallback: false,
        includeForks: false,
        perPage: 5,
        page: 1,
        signal: controller.signal
      });
      const report = mergeGitHubDiscoveryReports(gitHubReportsFromCarrierReports(discovery.carrierReports));
      if (abortRef.current !== controller) {
        return;
      }
      setClientDiscoveryResults(report.results, report.rateLimitRemaining, report.incompleteResults);
      setClientDiscoveryStatus(
        `${discovery.message}; rate ${report.rateLimitRemaining ?? "unknown"}`,
        discovery.status === "ok" || discovery.status === "partial"
          ? "status-good"
          : discovery.status === "failed" || discovery.status === "rate_limited"
            ? "status-bad"
            : "status-warn"
      );
    } catch (error) {
      if (abortRef.current !== controller) {
        return;
      }
      setClientDiscoveryStatus(controller.signal.aborted ? "cancelled" : errorMessage(error), controller.signal.aborted ? "status-warn" : "status-bad");
    } finally {
      if (abortRef.current === controller) {
        setClientDiscoveryRunning(false);
      }
    }
  }, [client.discoveryQuery, setClientDiscoveryResults, setClientDiscoveryRunning, setClientDiscoveryStatus]);

  useEffect(() => {
    void runDiscovery();
    return () => {
      abortRef.current?.abort();
    };
  }, [runDiscovery]);

  const discoveryRows = useMemo(() => filterDiscoveryResults(client.discoveryResults, resultSearch), [client.discoveryResults, resultSearch]);
  const traceRows = useMemo(() => filterTraceEvents(client.federationTrace.events, traceSearch), [client.federationTrace.events, traceSearch]);
  const traceAlice = useMemo(() => tracePeerPreview(client.federationTrace.events, "Alice", client.alicePeerId), [client.alicePeerId, client.federationTrace.events]);
  const traceBob = useMemo(() => tracePeerPreview(client.federationTrace.events, "Bob", client.bobPeerId), [client.bobPeerId, client.federationTrace.events]);
  const traceColumns = useMemo<TableColumnsType<CarrierHoppingTraceEvent>>(() => [
    {
      title: "Time",
      dataIndex: "atMs",
      key: "atMs",
      width: 86,
      sorter: (left, right) => left.atMs - right.atMs,
      render: (value: number) => `${String(value)} ms`
    },
    {
      title: "Status",
      dataIndex: "status",
      key: "status",
      width: 96,
      sorter: (left, right) => left.status.localeCompare(right.status),
      render: (value: CarrierHoppingTraceStatus) => <Tag color={traceStatusColor(value)}>{value}</Tag>
    },
    {
      title: "Step",
      dataIndex: "label",
      key: "label",
      sorter: (left, right) => left.label.localeCompare(right.label),
      render: (value: string, event) => (
        <Space direction="vertical" size={2}>
          <span>{value}</span>
          <span className="table-muted">{event.kind}{event.side === undefined ? "" : ` / ${event.side}`}</span>
        </Space>
      )
    },
    {
      title: "Route",
      dataIndex: "route",
      key: "route",
      sorter: (left, right) => (left.route ?? "").localeCompare(right.route ?? ""),
      render: (value: string | undefined) => <span className="mono-cell">{value ?? "-"}</span>
    },
    {
      title: "Ids",
      key: "ids",
      render: (_, event) => (
        <Space direction="vertical" size={2}>
          <span className="mono-cell">peer {event.peerIdPreview ?? "-"}</span>
          <span className="mono-cell">route {event.routeIdPreview ?? "-"}</span>
          <span className="mono-cell">delivery {event.deliveryIdPreview ?? "-"}</span>
        </Space>
      )
    },
    {
      title: "Counters",
      key: "counters",
      width: 130,
      render: (_, event) => (
        <Space direction="vertical" size={2}>
          <span>hints {String(event.routeHintCount ?? 0)}</span>
          <span>pending {String(event.pendingCount ?? 0)}</span>
        </Space>
      )
    },
    {
      title: "Detail",
      dataIndex: "detail",
      key: "detail",
      render: (value: string | undefined) => <span className="table-muted">{value ?? "-"}</span>
    }
  ], []);
  const discoveryColumns = useMemo<TableColumnsType<GitHubDiscoveryResult>>(() => [
    {
      title: "Repository",
      dataIndex: "repository",
      key: "repository",
      sorter: (left, right) => left.repository.localeCompare(right.repository),
      render: (value: string, result) => <a href={result.htmlUrl} rel="noreferrer" target="_blank">{value}</a>
    },
    {
      title: "Branch",
      key: "branch",
      sorter: (left, right) => left.defaultBranch.localeCompare(right.defaultBranch),
      render: (_, result) => `${result.defaultBranch}${result.fork ? " fork" : ""}`
    },
    {
      title: "Records",
      key: "records",
      sorter: (left, right) => left.wrapperCount - right.wrapperCount,
      render: (_, result) => (
        <>
          <strong>{result.wrapperCount}</strong>
          {result.firstWrapperPreview === null ? "" : ` ${result.firstWrapperPreview}`}
        </>
      )
    },
    {
      title: "Validation",
      key: "validation",
      sorter: (left, right) => left.acceptedCount - right.acceptedCount || left.rejectedCount - right.rejectedCount,
      render: (_, result) => (
        <Space direction="vertical" size={4}>
          <span>
            <Tag color="green">{result.acceptedCount} accepted</Tag>
            <Tag color={result.rejectedCount > 0 ? "red" : "default"}>{result.rejectedCount} rejected</Tag>
          </span>
          {result.reason === null ? null : <span className="table-muted">{result.reason}</span>}
          {result.records.map((record) => (
            <span className={`record-validation is-${record.validation}`} key={`${result.recordsUrl}-${record.wrapperPreview}`}>
              {record.validation}: {record.reason}
            </span>
          ))}
        </Space>
      )
    },
    {
      title: "Relay endpoint",
      key: "relayEndpoint",
      sorter: (left, right) => textValue(left, "relayEndpoint").localeCompare(textValue(right, "relayEndpoint")),
      render: (_, result) => <span className="mono-cell">{firstAcceptedValue(result.records, "relayEndpoint") ?? "-"}</span>
    },
    {
      title: "Relay key",
      key: "senderPublicKey",
      sorter: (left, right) => textValue(left, "senderPublicKey").localeCompare(textValue(right, "senderPublicKey")),
      render: (_, result) => <span className="mono-cell">{firstAcceptedValue(result.records, "senderPublicKey") ?? "-"}</span>
    },
    {
      title: "Expiry",
      key: "expiresAt",
      sorter: (left, right) => (firstAcceptedValue(left.records, "expiresAt") ?? 0) - (firstAcceptedValue(right.records, "expiresAt") ?? 0),
      render: (_, result) => formatUnixSeconds(firstAcceptedValue(result.records, "expiresAt"))
    },
    {
      title: "Profile",
      key: "profile",
      sorter: (left, right) => textValue(left, "profileMultihash").localeCompare(textValue(right, "profileMultihash")),
      render: (_, result) => <span className="mono-cell">{firstAcceptedValue(result.records, "profileMultihash") ?? "-"}</span>
    }
  ], []);

  return (
    <section className="client-layout" data-panel="client" aria-label="Client discovery">
      <section className="panel control-panel client-summary" aria-label="Client GitHub discovery controls">
        <div className="client-discovery-controls">
          <div className="control-row">
            <label htmlFor="client-discovery-query">Locator</label>
            <Input id="client-discovery-query" readOnly type="text" value={client.discoveryQuery} />
          </div>
          <Space className="client-discovery-actions" wrap>
            <Button icon={<ReloadOutlined />} type="primary" disabled={client.discoveryRunning} onClick={() => { void runDiscovery(); }}>
              Refresh
            </Button>
            <Button icon={<StopOutlined />} disabled={!client.discoveryRunning} onClick={() => { abortRef.current?.abort(); }}>
              Cancel
            </Button>
          </Space>
          <p className={client.discoveryStatusClass}>{client.discoveryStatus}</p>
        </div>
        <dl className="diagnostics client-diagnostics">
          <div>
            <Statistic title="Accepted" value={sumResults(client.discoveryResults, "acceptedCount")} />
          </div>
          <div>
            <Statistic title="Rejected" value={sumResults(client.discoveryResults, "rejectedCount")} />
          </div>
          <div>
            <Statistic title="Rate" value={client.rateLimitRemaining ?? "-"} />
          </div>
        </dl>
        <div className="client-route-panel">
          <div className="client-route">
            <span>Route</span>
            <strong>{transport.route?.endpointUri ?? "-"}</strong>
            <small>{routeSourceLabel(client.routeMode, transport.route?.endpointUri ?? null, client.relaySource)}</small>
          </div>
          <div className="client-route-controls">
            <div className="control-row">
              <label htmlFor="client-route-mode">Route source</label>
              <Select
                id="client-route-mode"
                value={client.routeMode}
                options={[
                  { label: "Discovery", value: "discovery" },
                  { label: "Manual", value: "manual" }
                ]}
                onChange={(value) => { setClientRouteMode(value); }}
              />
            </div>
            <div className="control-row">
              <label htmlFor="client-manual-endpoint">Endpoint</label>
              <Input
                id="client-manual-endpoint"
                name="client-manual-endpoint"
                type="text"
                value={client.manualRelayEndpointUri}
                onChange={(event) => { setClientManualRouteField("manualRelayEndpointUri", event.currentTarget.value); }}
              />
            </div>
            <div className="control-row">
              <label htmlFor="client-manual-relay-key">Relay public key</label>
              <Input
                id="client-manual-relay-key"
                name="client-manual-relay-key"
                type="text"
                value={client.manualRelayPublicKey}
                onChange={(event) => { setClientManualRouteField("manualRelayPublicKey", event.currentTarget.value); }}
              />
            </div>
            <div className="control-row">
              <label htmlFor="client-manual-profile">Profile</label>
              <Input
                id="client-manual-profile"
                name="client-manual-profile"
                type="text"
                value={client.manualProfileMultihash}
                onChange={(event) => { setClientManualRouteField("manualProfileMultihash", event.currentTarget.value); }}
              />
            </div>
          </div>
        </div>
      </section>

      <section className="panel output-panel github-discovery-results client-discovery-results" aria-label="Client GitHub discovery results">
        <Input.Search
          allowClear
          placeholder="Search repository, endpoint, key, profile"
          value={resultSearch}
          onChange={(event) => { setResultSearch(event.currentTarget.value); }}
        />
        <Table
          columns={discoveryColumns}
          dataSource={discoveryRows}
          pagination={{ pageSize: 6, showSizeChanger: true }}
          rowKey="recordsUrl"
          scroll={{ x: 1160 }}
          size="small"
        />
      </section>

      <section className="panel output-panel client-transport-panel" aria-label="Client same-relay transport">
        <div className="section-heading">
          <h2>Same-relay transport</h2>
          <p className={client.transportStatusClass}>{client.transportStatus}</p>
        </div>
        <Space wrap>
          <Button icon={<ApiOutlined />} type="primary" disabled={transport.route === null || client.transportRunning} onClick={() => { void transport.attachPair(); }}>
            Attach test pair
          </Button>
          <Button icon={<PlayCircleOutlined />} disabled={client.alicePeerId === "" || client.transportRunning} onClick={() => { void transport.sendOpaqueEnvelope(); }}>
            Send envelope
          </Button>
          <Button icon={<StopOutlined />} disabled={client.bobPeerId === "" || client.transportRunning} onClick={() => { void transport.disconnectBobAndSend(); }}>
            Drop Bob
          </Button>
          <Button icon={<SyncOutlined />} disabled={client.bobPeerId === "" || client.transportRunning} onClick={() => { void transport.reconnectBobAndRetry(); }}>
            Reconnect retry
          </Button>
          <Button icon={<BranchesOutlined />} disabled={client.discoveryRunning || client.transportRunning} onClick={() => { void transport.runCarrierHopPoC(); }}>
            Run carrier-hop PoC
          </Button>
          <Button onClick={() => { transport.reset(); }}>
            Reset
          </Button>
        </Space>
        <dl className="diagnostics client-transport-diagnostics">
          <div>
            <dt>Relay ACK</dt>
            <dd>{String(client.relayAckCount)}</dd>
          </div>
          <div>
            <dt>Peer receipt</dt>
            <dd>{String(client.peerReceiptCount)}</dd>
          </div>
          <div>
            <dt>Pending</dt>
            <dd>{String(client.pendingCount)}</dd>
          </div>
          <div>
            <dt>Unavailable</dt>
            <dd>{String(client.unavailableCount)}</dd>
          </div>
        </dl>
        <dl className="diagnostics client-peer-diagnostics">
          <div>
            <dt>Alice</dt>
            <dd>{client.alicePeerId === "" ? "-" : shortId(client.alicePeerId)}</dd>
          </div>
          <div>
            <dt>Bob</dt>
            <dd>{client.bobPeerId === "" ? "-" : shortId(client.bobPeerId)}</dd>
          </div>
          <div>
            <dt>Relay</dt>
            <dd>{client.relayEndpointUri === "" ? "-" : client.relayEndpointUri}</dd>
          </div>
        </dl>

        <section className="federation-trace" aria-label="Federation trace">
          <div className="section-heading">
            <h2>Federation trace</h2>
            <p className={client.federationTrace.migrated ? "status-good" : "status-warn"}>
              {federationTraceStatus(client.federationTrace.migrated, client.federationTrace.events.length)}
            </p>
          </div>
          <div className="federation-path" aria-label="Current relay path">
            <TraceNode label="Alice" value={traceAlice} tone="client" />
            <TraceEdge label="attach" />
            <TraceNode label="Active relay" value={client.federationTrace.activeRoute ?? client.relayEndpointUri} tone="relay" />
            <TraceEdge label={client.federationTrace.migrated ? "migrate" : "bridge"} />
            <TraceNode label="Next relay" value={client.federationTrace.migrationRoute ?? "-"} tone={client.federationTrace.migrated ? "relay" : "muted"} />
            <TraceEdge label="deliver" />
            <TraceNode label="Bob" value={traceBob} tone="client" />
          </div>
          <div className="federation-route-tags" aria-label="Validated relay routes">
            {client.federationTrace.routeSnapshot.length === 0 ? <Tag>No route snapshot</Tag> : client.federationTrace.routeSnapshot.map((route) => (
              <Tag className="route-tag" color={route === client.federationTrace.activeRoute || route === client.federationTrace.migrationRoute ? "blue" : "default"} key={route}>
                {route}
              </Tag>
            ))}
            {client.federationTrace.routeHints.length === 0 ? <Tag>No route hints</Tag> : client.federationTrace.routeHints.map((routeHint, index) => (
              <Tag className="route-tag" color="purple" key={`hint-${String(index)}-${routeHint}`}>
                hint {routeHint}
              </Tag>
            ))}
          </div>
          <Input.Search
            allowClear
            className="trace-search"
            placeholder="Search trace"
            value={traceSearch}
            onChange={(event) => { setTraceSearch(event.currentTarget.value); }}
          />
          <Table
            columns={traceColumns}
            dataSource={traceRows}
            pagination={{ pageSize: 8, showSizeChanger: true }}
            rowKey="id"
            scroll={{ x: 1040 }}
            size="small"
          />
        </section>
        <ol className="client-event-log" aria-label="Transport events">
          {client.transportEvents.map((event, index) => (
            <li key={`${String(index)}-${event}`}>{event}</li>
          ))}
        </ol>
      </section>
    </section>
  );
}

type TraceNodeTone = "client" | "relay" | "muted";

function TraceNode({ label, value, tone }: { readonly label: string; readonly value: string; readonly tone: TraceNodeTone }): React.JSX.Element {
  return (
    <div className={`federation-node is-${tone}`}>
      <span>{label}</span>
      <strong>{value === "" ? "-" : value}</strong>
    </div>
  );
}

function TraceEdge({ label }: { readonly label: string }): React.JSX.Element {
  return (
    <div className="federation-edge">
      <span>{label}</span>
    </div>
  );
}

function sumResults(results: readonly { readonly acceptedCount: number; readonly rejectedCount: number }[], key: "acceptedCount" | "rejectedCount"): number {
  return results.reduce((total, result) => total + result[key], 0);
}

function filterDiscoveryResults(results: readonly GitHubDiscoveryResult[], query: string): readonly GitHubDiscoveryResult[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return results;
  }
  return results.filter((result) => [
    result.repository,
    result.defaultBranch,
    result.reason ?? "",
    firstAcceptedValue(result.records, "relayEndpoint") ?? "",
    firstAcceptedValue(result.records, "senderPublicKey") ?? "",
    firstAcceptedValue(result.records, "profileMultihash") ?? "",
    ...result.records.map((record) => `${record.validation} ${record.reason} ${record.wrapperPreview}`)
  ].some((value) => value.toLowerCase().includes(needle)));
}

function filterTraceEvents(events: readonly CarrierHoppingTraceEvent[], query: string): readonly CarrierHoppingTraceEvent[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return events;
  }
  return events.filter((event) => [
    event.kind,
    event.status,
    event.label,
    event.side ?? "",
    event.route ?? "",
    event.routeIdPreview ?? "",
    event.peerIdPreview ?? "",
    event.deliveryIdPreview ?? "",
    event.detail ?? ""
  ].some((value) => value.toLowerCase().includes(needle)));
}

function tracePeerPreview(events: readonly CarrierHoppingTraceEvent[], side: "Alice" | "Bob", fallbackPeerId: string): string {
  if (fallbackPeerId !== "") {
    return shortId(fallbackPeerId);
  }
  const peerEvent = events.find((event) => event.side === side && event.peerIdPreview !== undefined);
  return peerEvent?.peerIdPreview ?? "-";
}

function traceStatusColor(status: CarrierHoppingTraceStatus): string {
  switch (status) {
    case "ok":
      return "green";
    case "pending":
      return "gold";
    case "warn":
      return "orange";
    case "failed":
      return "red";
  }
}

function federationTraceStatus(migrated: boolean, eventCount: number): string {
  if (eventCount === 0) {
    return "no trace yet";
  }
  return migrated ? "migration observed" : "route observed";
}

function textValue(result: GitHubDiscoveryResult, key: "relayEndpoint" | "profileMultihash" | "senderPublicKey"): string {
  return firstAcceptedValue(result.records, key) ?? "";
}

function firstAcceptedValue<K extends "relayEndpoint" | "expiresAt" | "profileMultihash" | "senderPublicKey">(
  records: readonly GitHubValidatedRecord[],
  key: K
): K extends "expiresAt" ? number | null : string | null {
  const accepted = records.find((record) => record.validation === "accepted");
  return (accepted?.[key] ?? null) as K extends "expiresAt" ? number | null : string | null;
}

function formatUnixSeconds(value: number | null): string {
  if (value === null) {
    return "-";
  }
  return new Date(value * 1000).toISOString();
}

function shortId(value: string): string {
  return value.length <= 14 ? value : `${value.slice(0, 14)}...`;
}

function routeSourceLabel(routeMode: "discovery" | "manual", endpointUri: string | null, relaySource: string): string {
  if (routeMode === "manual") {
    return "manual route material";
  }
  if (relaySource !== "") {
    return relaySource;
  }
  return endpointUri === null ? "no accepted relay route" : "discovery route selected";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "client discovery failed";
}
