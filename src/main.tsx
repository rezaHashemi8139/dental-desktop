import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { initI18n } from "./i18n";
import { RouterProvider } from "@tanstack/react-router";
import { loadSession } from "./auth/store";
import { initConnectivity } from "./auth/connectivity";
import { router } from "./router";
import { DirectionProvider } from "./i18n/direction-provider";
import { initTheme } from "./theme/theme";
import { lockDown } from "./lib/lockdown";
import { initSync } from "./lib/sync";
import { initUpdates } from "./lib/update";
import "./index.css";

// Before anything is drawn, so the page never flashes in the wrong colors.
initTheme();
lockDown();

// The window starts hidden (tauri.conf.json) so the empty white web view is never
// seen. Show it once the splash in index.html has been painted.
requestAnimationFrame(() =>
  requestAnimationFrame(() => {
    getCurrentWindow()
      .show()
      .catch((e) => console.warn("Could not show the window:", e));
  }),
);

// Languages (including downloaded ones) and the current login must be known
// before the first render: the router's guards decide the first page from them.
// Connectivity, updates and syncing are followed from the start, so no change is
// missed and a forced update shows at once.
Promise.all([initI18n(), loadSession(), initConnectivity(), initUpdates(), initSync()]).then(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <DirectionProvider>
        <RouterProvider router={router} />
      </DirectionProvider>
    </React.StrictMode>,
  );
});
