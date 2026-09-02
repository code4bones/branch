import { ApiOutlined, BranchesOutlined, PlayCircleOutlined, ReloadOutlined, SearchOutlined, StopOutlined, SyncOutlined } from "@ant-design/icons";
import { Button, Input, Select, Space, Statistic, Table, Tag, type TableColumnsType } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { discoverClientBootstrapBeacons } from "@code4bones/branch-core/discovery/client.js";
import type { CarrierHoppingTraceEvent, CarrierHoppingTraceStatus } from "@code4bones/branch-core/connectivity/carrier-hopping-poc.js";
import {
  discoverClientIdentityContacts,
  type IdentityContactObservation as DirectIdentityContactObservation
} from "@code4bones/branch-core/discovery/identity-contact.js";
import {
  createGitHubSearchCarrier,
  createGitHubIdentityContactSearchCarrier,
  gitHubReportsFromCarrierReports,
  mergeGitHubDiscoveryReports,
  type GitHubDiscoveryResult,
  type GitHubValidatedRecord
} from "@code4bones/branch-core/discovery/github.js";
import {
  fetchIdentityContactLookup,
  type IdentityContactLookupObservation,
  type IdentityContactLookupTrace,
  type IdentityContactRouteHint
} from "../identity-lookup.js";
import { useAdminStore } from "../store.js";
import { useSameRelayTransportLab } from "../use-same-relay-transport-lab.js";

export function ClientTool(): React.JSX.Element {
  const abortRef = useRef<AbortController | null>(null);
  const identityLookupAbortRef = useRef<AbortController | null>(null);
  const [resultSearch, setResultSearch] = useState("");
  const [traceSearch, setTraceSearch] = useState("");
  const [identityTraceSearch, setIdentityTraceSearch] = useState("");
  const client = useAdminStore((state) => state.client);
  const setClientDiscoveryRunning = useAdminStore((state) => state.setClientDiscoveryRunning);
  const setClientDiscoveryResults = useAdminStore((state) => state.setClientDiscoveryResults);
  const setClientDiscoveryStatus = useAdminStore((state) => state.setClientDiscoveryStatus);
  const setClientIdentityLookupField = useAdminStore((state) => state.setClientIdentityLookupField);
  const setClientIdentityLookupResult = useAdminStore((state) => state.setClientIdentityLookupResult);
  const setClientIdentityLookupRunning = useAdminStore((state) => state.setClientIdentityLookupRunning);
  const setClientIdentityLookupStatus = useAdminStore((state) => state.setClientIdentityLookupStatus);
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

  const runIdentityLookup = useCallback(async (): Promise<void> => {
    identityLookupAbortRef.current?.abort();
    const controller = new AbortController();
    identityLookupAbortRef.current = controller;
    setClientIdentityLookupRunning(true);
    setClientIdentityLookupResult(null);
    setClientIdentityLookupStatus("querying exact BranchID through relay mesh", "status-warn");
    const runDirectCarrierLookup = async () => discoverClientIdentityContacts({
      carrier: createGitHubIdentityContactSearchCarrier(),
      branchID: client.identityLookup.branchID,
      primaryQuery: client.discoveryQuery,
      fallbackQuery: null,
      includeFallback: false,
      includeForks: false,
      perPage: 5,
      page: 1,
      signal: controller.signal
    });
    try {
      const result = await fetchIdentityContactLookup({
        adminBaseUrl: client.identityLookup.adminBaseUrl,
        adminToken: client.identityLookup.adminToken,
        branchID: client.identityLookup.branchID,
        fetcher: (input, init) => fetch(input, { ...init, signal: controller.signal })
      });
      if (identityLookupAbortRef.current !== controller) {
        return;
      }
      if (result.accepted) {
        setClientIdentityLookupResult(result, []);
        setClientIdentityLookupStatus(identityLookupStatusText(result.accepted, result.trace.length, 0), "status-good");
        return;
      }
      const direct = await runDirectCarrierLookup();
      if (identityLookupAbortRef.current !== controller) {
        return;
      }
      setClientIdentityLookupResult(result, direct.observations);
      setClientIdentityLookupStatus(
        identityLookupStatusText(direct.acceptedCount > 0, result.trace.length, direct.observations.length),
        direct.acceptedCount > 0 ? "status-good" : "status-warn"
      );
    } catch (error) {
      if (identityLookupAbortRef.current !== controller) {
        return;
      }
      if (controller.signal.aborted) {
        setClientIdentityLookupStatus("cancelled", "status-warn");
        return;
      }
      try {
        const direct = await runDirectCarrierLookup();
        if (identityLookupAbortRef.current !== controller) {
          return;
        }
        setClientIdentityLookupResult(null, direct.observations);
        setClientIdentityLookupStatus(
          `relay lookup failed: ${errorMessage(error)}; ${identityLookupStatusText(direct.acceptedCount > 0, 0, direct.observations.length)}`,
          direct.acceptedCount > 0 ? "status-good" : "status-bad"
        );
      } catch (directError) {
        setClientIdentityLookupStatus(`relay lookup failed: ${errorMessage(error)}; direct carrier failed: ${errorMessage(directError)}`, "status-bad");
      }
    } finally {
      if (identityLookupAbortRef.current === controller) {
        setClientIdentityLookupRunning(false);
      }
    }
  }, [
    client.discoveryQuery,
    client.identityLookup.adminBaseUrl,
    client.identityLookup.adminToken,
    client.identityLookup.branchID,
    setClientIdentityLookupResult,
    setClientIdentityLookupRunning,
    setClientIdentityLookupStatus
  ]);

  useEffect(() => {
    void runDiscovery();
    return () => {
      abortRef.current?.abort();
      identityLookupAbortRef.current?.abort();
    };
  }, [runDiscovery]);

  const discoveryRows = useMemo(() => filterDiscoveryResults(client.discoveryResults, resultSearch), [client.discoveryResults, resultSearch]);
  const traceRows = useMemo(() => filterTraceEvents(client.federationTrace.events, traceSearch), [client.federationTrace.events, traceSearch]);
  const identityTraceRows = useMemo(
    () => filterIdentityLookupTrace(client.identityLookup.result?.trace ?? [], identityTraceSearch),
    [client.identityLookup.result?.trace, identityTraceSearch]
  );
  const identityDirectColumns = useMemo<TableColumnsType<DirectIdentityContactObservation>>(() => [
    {
      title: "Carrier",
      key: "carrier",
      sorter: (left, right) => left.evidence.carrier.localeCompare(right.evidence.carrier),
      render: (_, item) => (
        <Space direction="vertical" size={2}>
          <Tag color="blue">{item.evidence.carrier}</Tag>
          <a href={item.evidence.sourceUrl} rel="noreferrer" target="_blank">{item.evidence.source}</a>
        </Space>
      )
    },
    {
      title: "Result",
      key: "result",
      sorter: (left, right) => Number(left.validation === "accepted") - Number(right.validation === "accepted") || left.reason.localeCompare(right.reason),
      render: (_, item) => (
        <Space direction="vertical" size={2}>
          <Tag color={item.validation === "accepted" ? "green" : "red"}>{item.validation}</Tag>
          <span className="table-muted">{item.reason}</span>
        </Space>
      )
    },
    {
      title: "BranchID",
      dataIndex: "branchID",
      key: "branchID",
      sorter: (left, right) => (left.branchID ?? "").localeCompare(right.branchID ?? ""),
      render: (value: string | null) => <span className="mono-cell">{value ?? "-"}</span>
    },
    {
      title: "Routes",
      key: "routes",
      sorter: (left, right) => left.routeHints.length - right.routeHints.length,
      render: (_, item) => (
        <Space direction="vertical" size={2}>
          {item.routeHints.length === 0 ? <span className="table-muted">-</span> : item.routeHints.map((hint) => (
            <span className="mono-cell" key={`${hint.uri}-${String(hint.priority)}`}>{hint.uri}</span>
          ))}
        </Space>
      )
    },
    {
      title: "Record",
      key: "record",
      render: (_, item) => (
        <Space direction="vertical" size={2}>
          <span className="mono-cell">{item.wrapperPreview}</span>
          <span className="table-muted">{formatUnixSeconds(item.expiresAt)}</span>
        </Space>
      )
    }
  ], []);
  const traceAlice = useMemo(() => tracePeerPreview(client.federationTrace.events, "Alice", client.alicePeerId), [client.alicePeerId, client.federationTrace.events]);
  const traceBob = useMemo(() => tracePeerPreview(client.federationTrace.events, "Bob", client.bobPeerId), [client.bobPeerId, client.federationTrace.events]);
  const identityLookupTraceColumns = useMemo<TableColumnsType<IdentityContactLookupTrace>>(() => [
    {
      title: "Source",
      dataIndex: "source",
      key: "source",
      sorter: (left, right) => left.source.localeCompare(right.source),
      render: (value: string) => <span className="mono-cell">{value}</span>
    },
    {
      title: "Step",
      dataIndex: "step",
      key: "step",
      sorter: (left, right) => left.step.localeCompare(right.step)
    },
    {
      title: "Result",
      key: "result",
      sorter: (left, right) => Number(left.accepted) - Number(right.accepted) || left.reason.localeCompare(right.reason),
      render: (_, item) => (
        <Space direction="vertical" size={2}>
          <Tag color={item.accepted ? "green" : "orange"}>{item.accepted ? "accepted" : "candidate"}</Tag>
          <span className="table-muted">{item.reason}</span>
        </Space>
      )
    },
    {
      title: "Candidate",
      dataIndex: "candidate",
      key: "candidate",
      width: 112,
      sorter: (left, right) => (left.candidate ?? 0) - (right.candidate ?? 0),
      render: (value: number | undefined) => value ?? "-"
    }
  ], []);
  const identityRouteHintColumns = useMemo<TableColumnsType<IdentityContactRouteHint>>(() => [
    {
      title: "Priority",
      dataIndex: "priority",
      key: "priority",
      width: 96,
      sorter: (left, right) => left.priority - right.priority
    },
    {
      title: "Transport",
      dataIndex: "transport",
      key: "transport",
      width: 104,
      render: (value: string) => <Tag color="blue">{value}</Tag>
    },
    {
      title: "URI",
      dataIndex: "uri",
      key: "uri",
      sorter: (left, right) => left.uri.localeCompare(right.uri),
      render: (value: string) => <span className="mono-cell">{value}</span>
    },
    {
      title: "Profile",
      dataIndex: "profile_multihash",
      key: "profile_multihash",
      sorter: (left, right) => left.profile_multihash.localeCompare(right.profile_multihash),
      render: (value: string) => <span className="mono-cell">{value}</span>
    }
  ], []);
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

      <section className="panel output-panel client-identity-lookup-panel" aria-label="BranchID identity lookup">
        <div className="section-heading">
          <h2>BranchID lookup</h2>
          <p className={client.identityLookup.statusClass}>{client.identityLookup.status}</p>
        </div>
        <div className="client-identity-lookup-controls">
          <div className="control-row">
            <label htmlFor="client-identity-branch-id">BranchID</label>
            <Input
              id="client-identity-branch-id"
              name="client-identity-branch-id"
              placeholder="br1..."
              value={client.identityLookup.branchID}
              onChange={(event) => { setClientIdentityLookupField("branchID", event.currentTarget.value); }}
            />
          </div>
          <div className="control-row">
            <label htmlFor="client-identity-admin-url">MASTER admin URL</label>
            <Input
              id="client-identity-admin-url"
              name="client-identity-admin-url"
              value={client.identityLookup.adminBaseUrl}
              onChange={(event) => { setClientIdentityLookupField("adminBaseUrl", event.currentTarget.value); }}
            />
          </div>
          <div className="control-row">
            <label htmlFor="client-identity-admin-token">Admin token</label>
            <Input.Password
              id="client-identity-admin-token"
              name="client-identity-admin-token"
              value={client.identityLookup.adminToken}
              onChange={(event) => { setClientIdentityLookupField("adminToken", event.currentTarget.value); }}
            />
          </div>
          <Space className="client-identity-lookup-actions" wrap>
            <Button icon={<SearchOutlined />} type="primary" disabled={client.identityLookup.running} onClick={() => { void runIdentityLookup(); }}>
              Lookup
            </Button>
            <Button icon={<StopOutlined />} disabled={!client.identityLookup.running} onClick={() => { identityLookupAbortRef.current?.abort(); }}>
              Cancel
            </Button>
          </Space>
        </div>
        <IdentityLookupObservationCard observation={client.identityLookup.result?.observation ?? null} />
        <Input.Search
          allowClear
          className="trace-search"
          placeholder="Search BranchID trace"
          value={identityTraceSearch}
          onChange={(event) => { setIdentityTraceSearch(event.currentTarget.value); }}
        />
        <Table
          columns={identityLookupTraceColumns}
          dataSource={identityTraceRows}
          pagination={{ pageSize: 6, showSizeChanger: true }}
          rowKey={(item) => `${item.source}-${item.step}-${item.reason}-${String(item.candidate ?? 0)}`}
          scroll={{ x: 760 }}
          size="small"
        />
        <Table
          columns={identityDirectColumns}
          dataSource={client.identityLookup.directObservations}
          pagination={{ pageSize: 5, showSizeChanger: true }}
          rowKey="observationId"
          scroll={{ x: 960 }}
          size="small"
        />
        <Table
          columns={identityRouteHintColumns}
          dataSource={client.identityLookup.result?.observation?.route_hints ?? []}
          pagination={false}
          rowKey={(item) => `${item.uri}-${String(item.priority)}`}
          scroll={{ x: 900 }}
          size="small"
        />
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

function IdentityLookupObservationCard({ observation }: { readonly observation: IdentityContactLookupObservation | null }): React.JSX.Element {
  if (observation === null) {
    return (
      <dl className="diagnostics client-identity-diagnostics">
        <div>
          <dt>Observation</dt>
          <dd>-</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>-</dd>
        </div>
        <div>
          <dt>Route hints</dt>
          <dd>0</dd>
        </div>
      </dl>
    );
  }
  return (
    <dl className="diagnostics client-identity-diagnostics">
      <div>
        <dt>Observation</dt>
        <dd>{`seq ${String(observation.sequence)} / ${formatUnixSeconds(observation.expires_at)}`}</dd>
      </div>
      <div>
        <dt>Source</dt>
        <dd className="mono-cell">{observation.source}</dd>
      </div>
      <div>
        <dt>Signed record</dt>
        <dd className="mono-cell">{`${observation.wrapper_preview} (${String(observation.wrapper_bytes)} bytes)`}</dd>
      </div>
      <div>
        <dt>BranchID</dt>
        <dd className="mono-cell">{observation.branch_id}</dd>
      </div>
      <div>
        <dt>Profiles</dt>
        <dd className="mono-cell">{observation.profile_multihashes.join(", ") || "-"}</dd>
      </div>
      <div>
        <dt>Route hints</dt>
        <dd>{String(observation.route_hints.length)}</dd>
      </div>
    </dl>
  );
}

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

function filterIdentityLookupTrace(events: readonly IdentityContactLookupTrace[], query: string): readonly IdentityContactLookupTrace[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return events;
  }
  return events.filter((event) => [
    event.source,
    event.step,
    event.reason,
    String(event.candidate ?? "")
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

function identityLookupStatusText(accepted: boolean, traceCount: number, directCount: number): string {
  const suffix = directCount === 0 ? "" : `; direct carrier observations ${String(directCount)}`;
  return accepted ? `accepted signed observation across ${String(traceCount)} trace steps${suffix}` : `no signed observation across ${String(traceCount)} trace steps${suffix}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "client discovery failed";
}
