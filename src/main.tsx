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

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
