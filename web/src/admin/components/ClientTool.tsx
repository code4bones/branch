import { useCallback, useEffect, useRef } from "react";

import { discoverClientBootstrapBeacons } from "../../discovery/client.js";
import {
  createGitLabSearchCarrier,
  gitLabReportsFromCarrierReports,
  mergeGitLabDiscoveryReports,
  type GitLabValidatedRecord
} from "../../discovery/gitlab.js";
import { useAdminStore } from "../store.js";
import { useSameRelayTransportLab } from "../use-same-relay-transport-lab.js";

export function ClientTool(): React.JSX.Element {
  const abortRef = useRef<AbortController | null>(null);
  const client = useAdminStore((state) => state.client);
  const setClientDiscoveryRunning = useAdminStore((state) => state.setClientDiscoveryRunning);
  const setClientDiscoveryResults = useAdminStore((state) => state.setClientDiscoveryResults);
  const setClientDiscoveryStatus = useAdminStore((state) => state.setClientDiscoveryStatus);
  const transport = useSameRelayTransportLab();

  const runDiscovery = useCallback(async (): Promise<void> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setClientDiscoveryRunning(true);
    setClientDiscoveryResults([], null, false);
    setClientDiscoveryStatus("searching GitLab project locator", "status-warn");
    try {
      const discovery = await discoverClientBootstrapBeacons({
        carrier: createGitLabSearchCarrier(),
        primaryQuery: client.discoveryQuery,
        fallbackQuery: null,
        includeFallback: false,
        includeForks: false,
        perPage: 5,
        page: 1,
        signal: controller.signal
      });
      const report = mergeGitLabDiscoveryReports(gitLabReportsFromCarrierReports(discovery.carrierReports));
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

  return (
    <section className="tool-grid is-active client-tool" data-panel="client" aria-label="Client discovery">
      <section className="panel control-panel client-summary" aria-label="Client GitLab discovery controls">
        <div className="control-row">
          <label htmlFor="client-discovery-query">Locator</label>
          <input id="client-discovery-query" readOnly type="text" value={client.discoveryQuery} />
        </div>
        <div className="button-row">
          <button type="button" disabled={client.discoveryRunning} onClick={() => { void runDiscovery(); }}>
            Refresh
          </button>
          <button type="button" disabled={!client.discoveryRunning} onClick={() => { abortRef.current?.abort(); }}>
            Cancel
          </button>
        </div>
        <p className={client.discoveryStatusClass}>{client.discoveryStatus}</p>
        <dl className="diagnostics client-diagnostics">
          <div>
            <dt>Accepted</dt>
            <dd>{String(sumResults(client.discoveryResults, "acceptedCount"))}</dd>
          </div>
          <div>
            <dt>Rejected</dt>
            <dd>{String(sumResults(client.discoveryResults, "rejectedCount"))}</dd>
          </div>
          <div>
            <dt>Rate</dt>
            <dd>{client.rateLimitRemaining ?? "-"}</dd>
          </div>
        </dl>
        <div className="client-route">
          <span>Route</span>
          <strong>{transport.route?.endpointUri ?? "-"}</strong>
          <small>{client.relaySource === "" ? "no accepted relay route" : client.relaySource}</small>
        </div>
      </section>

      <section className="panel output-panel github-discovery-results client-discovery-results" aria-label="Client GitLab discovery results">
        <table>
          <thead>
            <tr>
              <th>Project</th>
              <th>Branch</th>
              <th>Records</th>
              <th>Validation</th>
              <th>Relay endpoint</th>
              <th>Expiry</th>
              <th>Profile</th>
            </tr>
          </thead>
          <tbody>
            {client.discoveryResults.map((result) => (
              <tr key={result.recordsUrl}>
                <td><a href={result.htmlUrl} rel="noreferrer" target="_blank">{result.repository}</a></td>
                <td>{result.defaultBranch}{result.fork ? " fork" : ""}</td>
                <td>{result.wrapperCount}{result.firstWrapperPreview === null ? "" : ` ${result.firstWrapperPreview}`}</td>
                <td>
                  <strong>{result.acceptedCount}</strong> accepted / <strong>{result.rejectedCount}</strong> rejected
                  {result.reason === null ? "" : `; ${result.reason}`}
                  {result.records.map((record) => (
                    <div className={`record-validation is-${record.validation}`} key={`${result.recordsUrl}-${record.wrapperPreview}`}>
                      {record.validation}: {record.reason}
                    </div>
                  ))}
                </td>
                <td>{firstAcceptedValue(result.records, "relayEndpoint") ?? "-"}</td>
                <td>{formatUnixSeconds(firstAcceptedValue(result.records, "expiresAt"))}</td>
                <td>{firstAcceptedValue(result.records, "profileMultihash") ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel output-panel client-transport-panel" aria-label="Client same-relay transport">
        <div className="section-heading">
          <h2>Same-relay transport</h2>
          <p className={client.transportStatusClass}>{client.transportStatus}</p>
        </div>
        <div className="button-row">
          <button type="button" disabled={transport.route === null || client.transportRunning} onClick={() => { void transport.attachPair(); }}>
            Attach test pair
          </button>
          <button type="button" disabled={client.alicePeerId === "" || client.transportRunning} onClick={() => { void transport.sendOpaqueEnvelope(); }}>
            Send envelope
          </button>
          <button type="button" disabled={client.bobPeerId === "" || client.transportRunning} onClick={() => { void transport.disconnectBobAndSend(); }}>
            Drop Bob
          </button>
          <button type="button" disabled={client.bobPeerId === "" || client.transportRunning} onClick={() => { void transport.reconnectBobAndRetry(); }}>
            Reconnect retry
          </button>
          <button type="button" disabled={client.discoveryRunning || client.transportRunning} onClick={() => { void transport.runCarrierHopPoC(); }}>
            Run carrier-hop PoC
          </button>
          <button type="button" onClick={() => { transport.reset(); }}>
            Reset
          </button>
        </div>
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

function firstAcceptedValue<K extends "relayEndpoint" | "expiresAt" | "profileMultihash">(
  records: readonly GitLabValidatedRecord[],
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
