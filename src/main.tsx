import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./index.css";
import { initTauriBridge } from "./tauri_bridge";

// ─── Bootstrap ────────────────────────────────────────────────────────────────
// In Tauri mode we must initialise the bridge (import @tauri-apps/api/core)
// before React mounts so that convertFileSrcSync() works synchronously from
// the very first render.  In a plain browser context this is a no-op.

async function bootstrap() {
  await initTauriBridge();

  const root = document.getElementById("root");
  if (!root) throw new Error("Root element not found");

  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

bootstrap().catch((err) => {
  // If the bridge fails to initialise we still want the app to render —
  // it will fall back to web-mode asset resolution.
  console.error("[main] Bootstrap error:", err);

  const root = document.getElementById("root");
  if (root) {
    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  }
});
