var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
import path from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
var host = process.env.TAURI_DEV_HOST;
var KEY_PARAM = "dev-key";
var KEY_COOKIE = "dev-key";
/**
 * Dev server only: answers the app window and nobody else. `scripts/dev.mjs`
 * (pnpm start) makes a random key per run and opens the window with
 * `?dev-key=<key>`; the first request trades it for an HttpOnly cookie and every
 * request without that cookie gets 403. So a browser on the same port gets nothing.
 */
function appWindowOnly() {
    var digest = function (value) { return createHash("sha256").update(value).digest(); };
    var sameKey = function (a, b) { return timingSafeEqual(digest(a), digest(b)); };
    return {
        name: "app-window-only",
        apply: "serve",
        configureServer: function (server) {
            var key = process.env.DEV_ACCESS_KEY;
            server.middlewares.use(function (req, res, next) {
                var _a, _b, _c;
                if (!key) {
                    res.statusCode = 403;
                    res.setHeader("Content-Type", "text/plain; charset=utf-8");
                    res.end("Start the app with `pnpm start`. The dev server does not serve browsers.");
                    return;
                }
                var url = new URL((_a = req.url) !== null && _a !== void 0 ? _a : "/", "http://localhost");
                var given = url.searchParams.get(KEY_PARAM);
                if (given !== null && sameKey(given, key)) {
                    // Swap the key for a cookie and drop it from the address.
                    url.searchParams.delete(KEY_PARAM);
                    res.statusCode = 302;
                    res.setHeader("Set-Cookie", "".concat(KEY_COOKIE, "=").concat(key, "; Path=/; HttpOnly; SameSite=Strict"));
                    res.setHeader("Location", url.pathname + url.search);
                    res.end();
                    return;
                }
                var cookie = (_c = ((_b = req.headers.cookie) !== null && _b !== void 0 ? _b : "")
                    .split(";")
                    .map(function (part) { return part.trim().split("="); })
                    .find(function (_a) {
                    var name = _a[0];
                    return name === KEY_COOKIE;
                })) === null || _c === void 0 ? void 0 : _c[1];
                if (cookie !== undefined && sameKey(cookie, key))
                    return next();
                res.statusCode = 403;
                res.setHeader("Content-Type", "text/plain; charset=utf-8");
                res.end("Forbidden");
            });
        },
    };
}
// https://vite.dev/config/
export default defineConfig(function () { return __awaiter(void 0, void 0, void 0, function () {
    return __generator(this, function (_a) {
        return [2 /*return*/, ({
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
                            host: host,
                            port: 1424,
                        }
                        : undefined,
                    watch: {
                        // 3. tell Vite to ignore watching `src-tauri`
                        ignored: ["**/src-tauri/**"],
                    },
                },
            })];
    });
}); });
