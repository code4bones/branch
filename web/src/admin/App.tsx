import {
  ApiOutlined,
  BranchesOutlined,
  GithubOutlined,
  GitlabOutlined,
  HomeOutlined,
  PictureOutlined,
  RadarChartOutlined
} from "@ant-design/icons";
import { ConfigProvider, Layout, Menu, Typography, theme, type MenuProps } from "antd";
import { useEffect } from "react";
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";

import { AdminStoreProvider, type AdminTab, useAdminStore } from "./store.js";
import { ClientTool } from "./components/ClientTool.js";
import { GitHubTool } from "./components/GitHubTool.js";
import { GitLabTool } from "./components/GitLabTool.js";
import { RelayMonitorTool } from "./components/RelayMonitorTool.js";
import { RibbonTool } from "./components/RibbonTool.js";

type AdminRoute = Exclude<AdminTab, never>;

const routeItems: readonly {
  readonly key: AdminRoute;
  readonly path: string;
  readonly label: string;
  readonly icon: React.ReactNode;
}[] = [
  { key: "ribbon", path: "/ribbon", label: "Ribbon Image", icon: <PictureOutlined /> },
  { key: "github", path: "/github", label: "GitHub", icon: <GithubOutlined /> },
  { key: "gitlab", path: "/gitlab", label: "GitLab", icon: <GitlabOutlined /> },
  { key: "relays", path: "/relays", label: "Relays", icon: <RadarChartOutlined /> },
  { key: "client", path: "/client", label: "Client", icon: <ApiOutlined /> }
];

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
            headerBg: "#0a0d11",
            siderBg: "#0f141a"
          },
          Menu: {
            darkItemBg: "#0f141a",
            darkSubMenuItemBg: "#0f141a",
            darkItemSelectedBg: "#164b48",
            darkItemSelectedColor: "#f4f7fb"
          },
          Table: {
            headerBg: "#18202a",
            rowHoverBg: "#18202a"
          }
        }
      }}
    >
      <AdminStoreProvider>
        <BrowserRouter basename="/admin">
          <AdminShell />
        </BrowserRouter>
      </AdminStoreProvider>
    </ConfigProvider>
  );
}

function AdminShell(): React.JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const setActiveTab = useAdminStore((state) => state.setActiveTab);
  const activeRoute = routeFromPath(location.pathname);

  useEffect(() => {
    if (location.pathname === "/" && location.hash === "#client") {
      void navigate("/client", { replace: true });
      return;
    }
    setActiveTab(activeRoute);
  }, [activeRoute, location.hash, location.pathname, navigate, setActiveTab]);

  const menuItems: MenuProps["items"] = routeItems.map((item) => ({
    key: item.key,
    icon: item.icon,
    label: <Link to={item.path}>{item.label}</Link>
  }));

  return (
    <Layout className="admin-layout">
      <Layout.Sider breakpoint="lg" className="admin-sider" collapsedWidth={0} width={248}>
        <div className="admin-brand">
          <BranchesOutlined aria-hidden="true" />
          <div>
            <Typography.Text className="kicker">Blue Ribbon Autonomous Network for Carrier Hopping</Typography.Text>
            <Typography.Title level={1}>Admin</Typography.Title>
          </div>
        </div>
        <Menu
          className="admin-side-menu"
          items={menuItems}
          mode="inline"
          selectedKeys={[activeRoute]}
          theme="dark"
        />
      </Layout.Sider>

      <Layout className="admin-main">
        <Layout.Header className="admin-header">
          <div>
            <Typography.Text className="kicker">B.R.A.N.C.H. operator console</Typography.Text>
            <Typography.Title id="admin-title" level={2}>{titleForRoute(activeRoute)}</Typography.Title>
          </div>
          <nav className="admin-nav" aria-label="Admin navigation">
            <a href="/"><HomeOutlined /> Status</a>
            <a href="/admin/ribbon" aria-current="page">Admin</a>
          </nav>
        </Layout.Header>

        <Layout.Content className="admin-workspace" aria-labelledby="admin-title">
          <Routes>
            <Route index element={<Navigate replace to="/ribbon" />} />
            <Route path="ribbon" element={<RibbonTool />} />
            <Route path="github" element={<GitHubTool />} />
            <Route path="gitlab" element={<GitLabTool />} />
            <Route path="relays" element={<RelayMonitorTool />} />
            <Route path="client" element={<ClientTool />} />
            <Route path="*" element={<Navigate replace to="/ribbon" />} />
          </Routes>
        </Layout.Content>
      </Layout>
    </Layout>
  );
}

function routeFromPath(pathname: string): AdminRoute {
  const firstSegment = pathname.split("/").filter(Boolean)[0];
  switch (firstSegment) {
    case "github":
    case "gitlab":
    case "relays":
    case "client":
      return firstSegment;
    default:
      return "ribbon";
  }
}

function titleForRoute(route: AdminRoute): string {
  return routeItems.find((item) => item.key === route)?.label ?? "Ribbon Image";
}
