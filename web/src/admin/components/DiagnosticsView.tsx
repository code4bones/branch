import { useAdminStore } from "../store.js";

export function DiagnosticsView(): React.JSX.Element {
  const diagnostics = useAdminStore((state) => state.diagnostics);
  const rows: ReadonlyArray<readonly [string, string]> = [
    ["Profile", diagnostics.profile],
    ["Status", diagnostics.status],
    ["Mode", diagnostics.mode],
    ["Payload", diagnostics.payloadLength],
    ["QR version", diagnostics.sourceSymbolVersion],
    ["Modules", diagnostics.moduleCount],
    ["Pitch", diagnostics.modulePitch],
    ["Quiet zone", diagnostics.quietZone],
    ["Canvas", diagnostics.canvas],
    ["ECC", diagnostics.ecc]
  ];

  return (
    <dl className="diagnostics" id="ribbon-diagnostics">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd className={label === "Status" ? diagnostics.statusClass : undefined}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
