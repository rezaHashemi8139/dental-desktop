import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { initI18n } from "./i18n";
import { RouterProvider } from "@tanstack/react-router";
import { loadSession } from "./auth/store";
import { router } from "./router";
import { DirectionProvider } from "./i18n/direction-provider";
import { initTheme } from "./theme/theme";
import { lockDown } from "./lib/lockdown";
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
Promise.all([initI18n(), loadSession()]).then(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <DirectionProvider>
        <RouterProvider router={router} />
      </DirectionProvider>
    </React.StrictMode>,
  );
});
