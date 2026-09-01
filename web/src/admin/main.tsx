import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { AdminApp } from "./App.js";

const mount = document.getElementById("admin-root");

if (!(mount instanceof HTMLElement)) {
  throw new Error("admin root missing");
}

const root = createRoot(mount);

flushSync(() => {
  root.render(<AdminApp />);
});

window.dispatchEvent(new Event("branch:admin-mounted"));

