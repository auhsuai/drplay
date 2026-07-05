import React from "react";
import ReactDOM from "react-dom/client";
import "./i18n";
import App from "./App";
import { Buffer } from "buffer";
import { initLogger } from "./utils/logger";

initLogger();

if (typeof window !== "undefined") {
  (window as any).Buffer = Buffer;
}

// Disable right click (context menu) to prevent copy/inspect
document.addEventListener('contextmenu', e => e.preventDefault());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
