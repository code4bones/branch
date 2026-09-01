const defaultBranchWrapper =
  "BRANCH0.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export function AdminApp(): React.JSX.Element {
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
        <button className="tab is-active" type="button" data-tab="ribbon">
          Ribbon Image
        </button>
        <button className="tab" type="button" data-tab="github">
          GitHub
        </button>
      </section>

      <section className="tool-grid is-active" data-panel="ribbon" aria-label="Ribbon Image generator">
        <form className="panel control-panel" id="ribbon-form">
          <label htmlFor="branch-wrapper">BRANCH0 wrapper</label>
          <textarea
            id="branch-wrapper"
            name="branch-wrapper"
            spellCheck={false}
            rows={9}
            placeholder={defaultBranchWrapper}
            defaultValue={defaultBranchWrapper}
          />

          <div className="control-row">
            <label htmlFor="cover-image">Cover image</label>
            <input id="cover-image" name="cover-image" type="file" accept="image/png,image/jpeg,image/webp" />
          </div>

          <div className="control-row">
            <label htmlFor="visual-mode">Visual mode</label>
            <select id="visual-mode" name="visual-mode" defaultValue="tint">
              <option value="seal">Seal</option>
              <option value="tint">Tint</option>
            </select>
          </div>

          <div className="control-row">
            <label htmlFor="quiet-zone">Quiet zone</label>
            <input id="quiet-zone" name="quiet-zone" type="number" min="4" max="12" step="1" defaultValue="8" />
          </div>

          <div className="control-row">
            <label htmlFor="carrier-size">Carrier size</label>
            <input
              id="carrier-size"
              name="carrier-size"
              type="number"
              min="320"
              max="1600"
              step="16"
              defaultValue="720"
            />
          </div>

          <div className="control-row">
            <label htmlFor="tint-strength">Tint strength</label>
            <input id="tint-strength" name="tint-strength" type="range" min="0" max="24" step="1" defaultValue="0" />
          </div>

          <div className="control-row">
            <label htmlFor="output-width">Output width</label>
            <input
              id="output-width"
              name="output-width"
              type="number"
              min="640"
              max="4096"
              step="10"
              defaultValue="1000"
            />
          </div>

          <div className="control-row">
            <label htmlFor="output-height">Output height</label>
            <input
              id="output-height"
              name="output-height"
              type="number"
              min="640"
              max="4096"
              step="10"
              defaultValue="1500"
            />
          </div>

          <div className="control-row">
            <label htmlFor="carrier-placement">Placement</label>
            <select id="carrier-placement" name="carrier-placement" defaultValue="bottom-right">
              <option value="center">Center</option>
              <option value="bottom-right">Bottom right</option>
              <option value="bottom-left">Bottom left</option>
              <option value="top-right">Top right</option>
              <option value="top-left">Top left</option>
            </select>
          </div>

          <div className="button-row">
            <button type="submit">Generate</button>
            <button type="button" id="download-ribbon" disabled>
              Download PNG
            </button>
          </div>
        </form>

        <section className="panel preview-panel" aria-label="Ribbon Image preview">
          <canvas id="ribbon-canvas" width="640" height="640" />
          <dl className="diagnostics" id="ribbon-diagnostics">
            <div>
              <dt>Profile</dt>
              <dd>ribbon-seal/0</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>idle</dd>
            </div>
          </dl>
          <div className="decode-controls">
            <label htmlFor="decode-image">Decode image</label>
            <input id="decode-image" name="decode-image" type="file" accept="image/png,image/jpeg,image/webp" />
            <button type="button" id="decode-ribbon">
              Decode
            </button>
          </div>
          <textarea id="decoded-wrapper" spellCheck={false} readOnly rows={5} />
        </section>
      </section>

      <section className="tool-grid" data-panel="github" aria-label="GitHub carrier generator">
        <form className="panel control-panel" id="github-form">
          <label htmlFor="github-records">BRANCH0 records</label>
          <textarea
            id="github-records"
            name="github-records"
            spellCheck={false}
            rows={9}
            placeholder={defaultBranchWrapper}
          />

          <div className="control-row">
            <label htmlFor="source-commit">Source commit</label>
            <input id="source-commit" name="source-commit" type="text" spellCheck={false} placeholder="optional-vcs-commit" />
          </div>

          <div className="button-row">
            <button type="submit">Generate</button>
            <button type="button" id="download-bundle" disabled>
              Download bundle
            </button>
          </div>
        </form>

        <section className="panel output-panel" aria-label="Generated GitHub files">
          <div className="file-tabs" id="file-tabs" role="tablist" aria-label="Generated files" />
          <textarea id="file-output" spellCheck={false} readOnly rows={18} />
          <div className="button-row">
            <button type="button" id="download-file" disabled>
              Download file
            </button>
            <button type="button" id="copy-file" disabled>
              Copy
            </button>
          </div>
        </section>
      </section>
    </main>
  );
}

