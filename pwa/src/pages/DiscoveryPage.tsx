import { developmentProfileMultihash } from "@code4bones/branch-core";
import { CheckCircleFilled, RadarChartOutlined, WarningFilled } from "@ant-design/icons";
import { Alert, Button, Input, Space, Spin, Typography } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { CHATS_PATH } from "../app/paths.js";
import { pwaReleaseVersion } from "../app/pwa-release.js";
import { findRelayRouteViaGitHub } from "../discovery/find-relay-route.js";
import { useConnection } from "../state/hooks.js";

export function DiscoveryPage(): React.JSX.Element {
  const navigate = useNavigate();
  const connection = useConnection();
  const abortRef = useRef<AbortController | null>(null);
  const [manualEndpoint, setManualEndpoint] = useState("");
  const [manualRelayKey, setManualRelayKey] = useState("");

  const isSearching = connection.routeStatus === "idle" || connection.routeStatus === "searching";

  const runDiscovery = useCallback((): void => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    connection.setRouteSearching();
    findRelayRouteViaGitHub(controller.signal)
      .then((result) => {
        if (abortRef.current !== controller) {
          return;
        }
        if (result.routes.length > 0) {
          connection.setRouteFound(result.routes, result.source);
        } else {
          connection.setRouteFailed(result.message);
        }
      })
      .catch((cause: unknown) => {
        if (abortRef.current !== controller) {
          return;
        }
        connection.setRouteFailed(cause instanceof Error ? cause.message : "relay discovery failed");
      });
  }, []);

  useEffect(() => {
    runDiscovery();
    return () => { abortRef.current?.abort(); };
  }, [runDiscovery]);

  useEffect(() => {
    if (connection.routeStatus === "found") {
      const timer = setTimeout(() => { void navigate(CHATS_PATH, { replace: true }); }, 500);
      return () => { clearTimeout(timer); };
    }
    return undefined;
  }, [connection.routeStatus, navigate]);

  const handleManualRoute = (): void => {
    const endpointUri = manualEndpoint.trim();
    const relayPublicKey = manualRelayKey.trim();
    if (endpointUri === "" || relayPublicKey === "") {
      return;
    }
    connection.setRouteFound([{ endpointUri, relayPublicKey, profileMultihash: developmentProfileMultihash }], "manual");
  };

  return (
    <section className="pwa-discovery" aria-label="Relay discovery">
      <div className={`pwa-discovery-mark${isSearching ? " is-searching" : ""}`}>
        {connection.routeStatus === "found" && <CheckCircleFilled className="is-found" />}
        {connection.routeStatus === "failed" && <WarningFilled className="is-failed" />}
        {isSearching && <RadarChartOutlined />}
      </div>
      <div className="pwa-discovery-title-row">
        <Typography.Title level={2}>Finding a relay</Typography.Title>
        <Typography.Text className="pwa-release-version" type="secondary">v{pwaReleaseVersion}</Typography.Text>
      </div>
      <Typography.Paragraph>
        B.R.A.N.C.H. has no owned server. This device searches public GitHub repositories for a
        signed relay bootstrap beacon before the messenger interface appears — every start is a
        fresh search, not a cached login.
      </Typography.Paragraph>
      <Spin spinning={isSearching}>
        <Typography.Text className="pwa-discovery-status" type="secondary">{connection.discoveryMessage}</Typography.Text>
      </Spin>
      {connection.routeStatus === "failed" && (
        <>
          <Alert message="No relay found yet" showIcon type="warning" />
          <Space>
            <Button onClick={runDiscovery} type="primary">Search again</Button>
          </Space>
          <div className="pwa-discovery-manual">
            <Typography.Text type="secondary">Or enter a known relay route manually</Typography.Text>
            <Input
              onChange={(event) => { setManualEndpoint(event.currentTarget.value); }}
              placeholder="wss://relay.example.org"
              value={manualEndpoint}
            />
            <Input
              onChange={(event) => { setManualRelayKey(event.currentTarget.value); }}
              placeholder="relay public key"
              value={manualRelayKey}
            />
            <Button onClick={handleManualRoute}>Use this route</Button>
          </div>
        </>
      )}
    </section>
  );
}
