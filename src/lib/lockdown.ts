import { invoke } from "@tauri-apps/api/core";

/**
 * Page-side part of the lockdown; the main part is the WebView2 settings in
 * src-tauri/src/lockdown.rs (browser shortcuts, context menu, zoom, autofill).
 * Text selection is turned off in src/index.css.
 */
export function lockDown() {
  // Second line of defence for the browser context menu.
  window.addEventListener("contextmenu", (event) => event.preventDefault());

  // Mouse back/forward buttons would navigate the web view.
  window.addEventListener("mouseup", (event) => {
    if (event.button === 3 || event.button === 4) event.preventDefault();
  });

  // Dragging a selection or a link out of the window.
  window.addEventListener("dragstart", (event) => {
    const target = event.target as HTMLElement | null;
    if (!target?.closest?.("input, textarea, [contenteditable='true']")) event.preventDefault();
  });

  if (import.meta.env.DEV) {
    // The browser's F12 is off; keep DevTools reachable while developing.
    window.addEventListener("keydown", (event) => {
      if (event.key === "F12") invoke("open_devtools").catch(() => {});
    });
  }
}
