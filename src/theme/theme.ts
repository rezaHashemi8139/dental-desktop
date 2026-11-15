import { useSyncExternalStore } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** "system" follows the Windows light/dark setting, also when it changes while the app is open. */
export type Theme = "light" | "dark" | "system";

export const THEMES: Theme[] = ["system", "light", "dark"];

const STORAGE_KEY = "theme";
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

let theme: Theme = readSavedTheme();
const listeners = new Set<() => void>();

function readSavedTheme(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && (THEMES as string[]).includes(saved)) return saved as Theme;
  } catch {
    // Storage unavailable: use the default.
  }
  return "system";
}

/** Sets the `dark` class used by the CSS (see index.css). */
function applyToPage() {
  const dark = theme === "dark" || (theme === "system" && darkQuery.matches);
  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  // Native parts (scrollbars, form controls) follow too.
  root.style.colorScheme = dark ? "dark" : "light";
}

/** Makes the window's title bar match. `null` lets it follow Windows. */
function applyToWindow() {
  getCurrentWindow()
    .setTheme(theme === "system" ? null : theme)
    .catch((e) => console.warn("Could not set the window theme:", e));
}

/** Applies the saved theme. Call once before rendering to avoid a flash of the wrong colors. */
export function initTheme() {
  applyToPage();
  applyToWindow();
  // When following the system, react to Windows switching between light and dark.
  darkQuery.addEventListener("change", () => {
    if (theme === "system") applyToPage();
  });
}

export function setTheme(next: Theme) {
  theme = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Storage unavailable: the choice just won't be remembered.
  }
  applyToWindow();
  applyToPage();
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The chosen theme ("system", "light" or "dark") and a way to change it. */
export function useTheme() {
  return { theme: useSyncExternalStore(subscribe, () => theme), setTheme };
}
