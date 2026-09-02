import { useEffect } from "react";

import { AdminStoreProvider, useAdminStore } from "./store.js";
import { ClientTool } from "./components/ClientTool.js";
import { GitHubTool } from "./components/GitHubTool.js";
import { GitLabTool } from "./components/GitLabTool.js";
import { RelayMonitorTool } from "./components/RelayMonitorTool.js";
import { RibbonTool } from "./components/RibbonTool.js";

export function AdminApp(): React.JSX.Element {
  return (
    <AdminStoreProvider>
      <AdminShell />
    </AdminStoreProvider>
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

  return (
    <main className="admin-shell" aria-labelledby="admin-title">
      <header className="admin-header">
        <div>
          <p className="kicker">Blue Ribbon Autonomous Network for Carrier Hopping</p>
          <h1 id="admin-title">Admin</h1>
        </div>
        <nav className="admin-nav" aria-label="Admin navigation">
          <a href="/">Status</a>
          <a
            href="/admin/"
            aria-current={activeTab === "client" ? undefined : "page"}
            onClick={(event) => {
              event.preventDefault();
              window.history.replaceState(null, "", "/admin/");
              setActiveTab("ribbon");
            }}
          >
            Admin
          </a>
          <a
            href="/admin/#client"
            aria-current={activeTab === "client" ? "page" : undefined}
            onClick={(event) => {
              event.preventDefault();
              window.history.replaceState(null, "", "/admin/#client");
              setActiveTab("client");
            }}
          >
            Client
          </a>
        </nav>
      </header>

      <section className="admin-tabs" aria-label="Admin tools">
        <button className={`tab${activeTab === "ribbon" ? " is-active" : ""}`} type="button" data-tab="ribbon" onClick={() => { window.history.replaceState(null, "", "/admin/"); setActiveTab("ribbon"); }}>
          Ribbon Image
        </button>
        <button className={`tab${activeTab === "github" ? " is-active" : ""}`} type="button" data-tab="github" onClick={() => { window.history.replaceState(null, "", "/admin/"); setActiveTab("github"); }}>
          GitHub
        </button>
        <button className={`tab${activeTab === "gitlab" ? " is-active" : ""}`} type="button" data-tab="gitlab" onClick={() => { window.history.replaceState(null, "", "/admin/"); setActiveTab("gitlab"); }}>
          GitLab
        </button>
        <button className={`tab${activeTab === "relays" ? " is-active" : ""}`} type="button" data-tab="relays" onClick={() => { window.history.replaceState(null, "", "/admin/"); setActiveTab("relays"); }}>
          Relays
        </button>
        <button className={`tab${activeTab === "client" ? " is-active" : ""}`} type="button" data-tab="client" onClick={() => { window.history.replaceState(null, "", "/admin/#client"); setActiveTab("client"); }}>
          Client
        </button>
      </section>

      {activeTab === "client" ? <ClientTool /> : activeTab === "ribbon" ? <RibbonTool /> : activeTab === "gitlab" ? <GitLabTool /> : activeTab === "relays" ? <RelayMonitorTool /> : <GitHubTool />}
    </main>
  );
}
