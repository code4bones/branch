import { AdminStoreProvider, useAdminStore } from "./store.js";
import { GitHubTool } from "./components/GitHubTool.js";
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

  return (
    <main className="admin-shell" aria-labelledby="admin-title">
      <header className="admin-header">
        <div>
          <p className="kicker">Blue Ribbon Autonomous Network for Carrier Hopping</p>
          <h1 id="admin-title">Admin</h1>
        </div>
        <nav className="admin-nav" aria-label="Admin navigation">
          <a href="/">Status</a>
          <a href="/admin/" aria-current="page">
            Admin
          </a>
        </nav>
      </header>

      <section className="admin-tabs" aria-label="Admin tools">
        <button className={`tab${activeTab === "ribbon" ? " is-active" : ""}`} type="button" data-tab="ribbon" onClick={() => { setActiveTab("ribbon"); }}>
          Ribbon Image
        </button>
        <button className={`tab${activeTab === "github" ? " is-active" : ""}`} type="button" data-tab="github" onClick={() => { setActiveTab("github"); }}>
          GitHub
        </button>
      </section>

      {activeTab === "ribbon" ? <RibbonTool /> : <GitHubTool />}
    </main>
  );
}
