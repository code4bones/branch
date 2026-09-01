import { useRef } from "react";

import { copyTextFromFallback, downloadText } from "../browser-files.js";
import { defaultBranchWrapper, githubBundleFilename } from "../defaults.js";
import { makeBundle, makeGitHubFiles, parseBranchRecords } from "../github-dropin.js";
import { useAdminStore } from "../store.js";

export function GitHubTool(): React.JSX.Element {
  const outputRef = useRef<HTMLTextAreaElement | null>(null);
  const github = useAdminStore((state) => state.github);
  const setGitHubRecords = useAdminStore((state) => state.setGitHubRecords);
  const setGitHubSourceCommit = useAdminStore((state) => state.setGitHubSourceCommit);
  const setGitHubFiles = useAdminStore((state) => state.setGitHubFiles);
  const setSelectedGitHubFile = useAdminStore((state) => state.setSelectedGitHubFile);
  const setGitHubStatus = useAdminStore((state) => state.setGitHubStatus);
  const selectedFile = github.files[github.selectedFile] ?? null;

  function onGenerate(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const recordsInput = readFormString(formData, "github-records");
    const sourceCommit = readFormString(formData, "source-commit");
    setGitHubRecords(recordsInput);
    setGitHubSourceCommit(sourceCommit);
    try {
      const records = parseBranchRecords(recordsInput);
      const files = makeGitHubFiles(records, sourceCommit.trim(), Math.floor(Date.now() / 1000));
      setGitHubFiles(files);
      setGitHubStatus("generated", "status-good");
    } catch (error) {
      setGitHubFiles([]);
      setGitHubStatus(error instanceof Error ? error.message : "generation failed", "status-bad");
    }
  }

  return (
    <section className="tool-grid is-active" data-panel="github" aria-label="GitHub carrier generator">
      <form className="panel control-panel" id="github-form" onSubmit={onGenerate}>
        <label htmlFor="github-records">BRANCH0 records</label>
        <textarea
          id="github-records"
          name="github-records"
          spellCheck={false}
          rows={9}
          placeholder={defaultBranchWrapper}
          value={github.records}
          onChange={(event) => { setGitHubRecords(event.currentTarget.value); }}
        />

        <div className="control-row">
          <label htmlFor="source-commit">Source commit</label>
          <input
            id="source-commit"
            name="source-commit"
            type="text"
            spellCheck={false}
            placeholder="optional-vcs-commit"
            value={github.sourceCommit}
            onChange={(event) => { setGitHubSourceCommit(event.currentTarget.value); }}
          />
        </div>

        <div className="button-row">
          <button type="submit">Generate</button>
          <button
            type="button"
            id="download-bundle"
            disabled={github.files.length === 0}
            onClick={() => { downloadText(makeBundle(github.files), githubBundleFilename, "text/plain"); }}
          >
            Download bundle
          </button>
        </div>
        <p className={github.statusClass}>{github.status}</p>
      </form>

      <section className="panel output-panel" aria-label="Generated GitHub files">
        <div className="file-tabs" id="file-tabs" role="tablist" aria-label="Generated files">
          {github.files.map((file, index) => (
            <button
              className={`file-tab${index === github.selectedFile ? " is-active" : ""}`}
              key={file.path}
              type="button"
              onClick={() => { setSelectedGitHubFile(index); }}
            >
              {file.path}
            </button>
          ))}
        </div>
        <textarea id="file-output" ref={outputRef} spellCheck={false} readOnly rows={18} value={selectedFile?.content ?? ""} />
        <div className="button-row">
          <button
            type="button"
            id="download-file"
            disabled={selectedFile === null}
            onClick={() => {
              if (selectedFile !== null) {
                downloadText(selectedFile.content, selectedFile.path.split("/").pop() ?? "branch-file.txt", selectedFile.type);
              }
            }}
          >
            Download file
          </button>
          <button
            type="button"
            id="copy-file"
            disabled={selectedFile === null}
            onClick={() => {
              if (selectedFile !== null) {
                void copyTextFromFallback(selectedFile.content, outputRef.current);
              }
            }}
          >
            Copy
          </button>
        </div>
      </section>
    </section>
  );
}

function readFormString(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}
