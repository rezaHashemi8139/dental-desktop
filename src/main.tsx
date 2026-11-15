import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { initI18n } from "./i18n";
import App from "./App";
import { DirectionProvider } from "./i18n/direction-provider";
import { initTheme } from "./theme/theme";
import "./index.css";

// Before anything is drawn, so the page never flashes in the wrong colors.
initTheme();

// The window starts hidden (tauri.conf.json) so the empty white web view is never
// seen. Show it once the splash in index.html has been painted.
requestAnimationFrame(() =>
  requestAnimationFrame(() => {
    getCurrentWindow()
      .show()
      .catch((e) => console.warn("Could not show the window:", e));
  }),
);

// Languages (including downloaded ones) must be loaded before the first render.
initI18n().then(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <DirectionProvider>
        <App />
      </DirectionProvider>
    </React.StrictMode>,
  );
});
