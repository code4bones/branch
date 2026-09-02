import { useEffect } from "react";
import { ApiOutlined, BranchesOutlined, GithubOutlined, GitlabOutlined, PictureOutlined, RadarChartOutlined } from "@ant-design/icons";
import { ConfigProvider, Layout, Tabs, Typography, theme, type TabsProps } from "antd";

import { AdminStoreProvider, useAdminStore } from "./store.js";
import { ClientTool } from "./components/ClientTool.js";
import { GitHubTool } from "./components/GitHubTool.js";
import { GitLabTool } from "./components/GitLabTool.js";
import { RelayMonitorTool } from "./components/RelayMonitorTool.js";
import { RibbonTool } from "./components/RibbonTool.js";

export function AdminApp(): React.JSX.Element {
  return (
    <ConfigProvider
      theme={{
        algorithm: theme.darkAlgorithm,
        token: {
          colorPrimary: "#57d2c6",
          colorBgBase: "#0a0d11",
          colorBgContainer: "#12171d",
          colorBorder: "#2d3845",
          borderRadius: 8,
          fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
        },
        components: {
          Layout: {
            bodyBg: "#0a0d11",
            headerBg: "#0a0d11"
          },
          Table: {
            headerBg: "#18202a",
            rowHoverBg: "#18202a"
          }
        }
      }}
    >
      <AdminStoreProvider>
        <AdminShell />
      </AdminStoreProvider>
    </ConfigProvider>
  );
}

function AdminShell(): React.JSX.Element {
  const activeTab = useAdminStore((state) => state.activeTab);
  const setActiveTab = useAdminStore((state) => state.setActiveTab);

  useEffect(() => {
    function syncHashTab(): void {
      if (window.location.hash === "#client") {
        setActiveTab("client");
      }
    }
    syncHashTab();
    window.addEventListener("hashchange", syncHashTab);
    return () => {
      window.removeEventListener("hashchange", syncHashTab);
    };
  }, [setActiveTab]);

  const items: TabsProps["items"] = [
    {
      key: "ribbon",
      label: "Ribbon Image",
      icon: <PictureOutlined />,
      children: <RibbonTool />
    },
    {
      key: "github",
      label: "GitHub",
      icon: <GithubOutlined />,
      children: <GitHubTool />
    },
    {
      key: "gitlab",
      label: "GitLab",
      icon: <GitlabOutlined />,
      children: <GitLabTool />
    },
    {
      key: "relays",
      label: "Relays",
      icon: <RadarChartOutlined />,
      children: <RelayMonitorTool />
    },
    {
      key: "client",
      label: "Client",
      icon: <ApiOutlined />,
      children: <ClientTool />
    }
  ];

  return (
    <Layout className="admin-layout">
      <main className="admin-shell" aria-labelledby="admin-title">
        <header className="admin-header">
          <div>
            <Typography.Text className="kicker">Blue Ribbon Autonomous Network for Carrier Hopping</Typography.Text>
            <Typography.Title id="admin-title" level={1}>Admin</Typography.Title>
          </div>
          <nav className="admin-nav" aria-label="Admin navigation">
            <a href="/">Status</a>
            <a href="/admin/" aria-current="page">Admin</a>
          </nav>
        </header>

        <Tabs
          activeKey={activeTab}
          className="admin-workspace-tabs"
          destroyOnHidden={false}
          items={items}
          onChange={(key) => {
            const tab = normalizeTab(key);
            window.history.replaceState(null, "", tab === "client" ? "/admin/#client" : "/admin/");
            setActiveTab(tab);
          }}
          tabBarExtraContent={<BranchesOutlined aria-hidden="true" className="admin-tab-mark" />}
        />
      </main>
    </Layout>
  );
}

function normalizeTab(value: string): "ribbon" | "github" | "gitlab" | "relays" | "client" {
  switch (value) {
    case "github":
    case "gitlab":
    case "relays":
    case "client":
      return value;
    default:
      return "ribbon";
  }
}
