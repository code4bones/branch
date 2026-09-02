import { ApiOutlined, BranchesOutlined, PlayCircleOutlined, ReloadOutlined, StopOutlined, SyncOutlined } from "@ant-design/icons";
import { Button, Input, Select, Space, Statistic, Table, Tag, type TableColumnsType } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { discoverClientBootstrapBeacons } from "../../discovery/client.js";
import {
  createGitHubSearchCarrier,
  gitHubReportsFromCarrierReports,
  mergeGitHubDiscoveryReports,
  type GitHubDiscoveryResult,
  type GitHubValidatedRecord
} from "../../discovery/github.js";
import { useAdminStore } from "../store.js";
import { useSameRelayTransportLab } from "../use-same-relay-transport-lab.js";

export function ClientTool(): React.JSX.Element {
  const abortRef = useRef<AbortController | null>(null);
  const [resultSearch, setResultSearch] = useState("");
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
    <section className="tool-grid is-active client-tool" data-panel="client" aria-label="Client discovery">
      <section className="panel control-panel client-summary" aria-label="Client GitHub discovery controls">
        <div className="control-row">
          <label htmlFor="client-discovery-query">Locator</label>
          <Input id="client-discovery-query" readOnly type="text" value={client.discoveryQuery} />
        </div>
        <Space wrap>
          <Button icon={<ReloadOutlined />} type="primary" disabled={client.discoveryRunning} onClick={() => { void runDiscovery(); }}>
            Refresh
          </Button>
          <Button icon={<StopOutlined />} disabled={!client.discoveryRunning} onClick={() => { abortRef.current?.abort(); }}>
            Cancel
          </Button>
        </Space>
        <p className={client.discoveryStatusClass}>{client.discoveryStatus}</p>
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
        <div className="client-route">
          <span>Route</span>
          <strong>{transport.route?.endpointUri ?? "-"}</strong>
          <small>{client.routeMode === "manual" ? "manual route material" : client.relaySource === "" ? "no accepted relay route" : client.relaySource}</small>
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
        <ol className="client-event-log" aria-label="Transport events">
          {client.transportEvents.map((event, index) => (
            <li key={`${String(index)}-${event}`}>{event}</li>
          ))}
        </ol>
      </section>
    </section>
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "client discovery failed";
}
