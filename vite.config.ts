import path from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

const KEY_PARAM = "dev-key";
const KEY_COOKIE = "dev-key";

/**
 * Dev server only: answers the app window and nobody else. `scripts/dev.mjs`
 * (pnpm start) makes a random key per run and opens the window with
 * `?dev-key=<key>`; the first request trades it for an HttpOnly cookie and every
 * request without that cookie gets 403. So a browser on the same port gets nothing.
 */
function appWindowOnly(): Plugin {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const sameKey = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

  return {
    name: "app-window-only",
    apply: "serve",
    configureServer(server) {
      const key = process.env.DEV_ACCESS_KEY;
      server.middlewares.use((req, res, next) => {
        if (!key) {
          res.statusCode = 403;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Start the app with `pnpm start`. The dev server does not serve browsers.");
          return;
        }

        const url = new URL(req.url ?? "/", "http://localhost");
        const given = url.searchParams.get(KEY_PARAM);
        if (given !== null && sameKey(given, key)) {
          // Swap the key for a cookie and drop it from the address.
          url.searchParams.delete(KEY_PARAM);
          res.statusCode = 302;
          res.setHeader("Set-Cookie", `${KEY_COOKIE}=${key}; Path=/; HttpOnly; SameSite=Strict`);
          res.setHeader("Location", url.pathname + url.search);
          res.end();
          return;
        }

        const cookie = (req.headers.cookie ?? "")
          .split(";")
          .map((part) => part.trim().split("="))
          .find(([name]) => name === KEY_COOKIE)?.[1];
        if (cookie !== undefined && sameKey(cookie, key)) return next();

        res.statusCode = 403;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Forbidden");
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [appWindowOnly(), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1424,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1424,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
