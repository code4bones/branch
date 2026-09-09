import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import "antd/dist/reset.css";

import { PwaApp } from "./app/App.js";
import { registerServiceWorker } from "./sw-register.js";

const mount = document.getElementById("pwa-root");

if (!(mount instanceof HTMLElement)) {
  throw new Error("pwa root missing");
}

const root = createRoot(mount);

flushSync(() => {
  root.render(<PwaApp />);
});

registerServiceWorker();

window.dispatchEvent(new Event("branch:pwa-mounted"));
