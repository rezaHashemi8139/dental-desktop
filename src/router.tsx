import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import { checkConnectivity } from "@/auth/connectivity";
import { connectionStatus, type ConnectionMode } from "@/auth/session";
import { getSession } from "@/auth/store";
import { RootLayout } from "@/pages/root-layout";
import { AppLayout } from "@/pages/app-layout";
import { AuthLayout, CheckingConnection, LoginPage, RegisterPage } from "@/pages/auth-layout";
import { DatabasePage } from "@/pages/database-page";
import { HomePage } from "@/pages/home-page";

/**
 * Pages. A desktop app has no address bar, so history lives in memory.
 *
 * /            → /home or /login
 * /login       ┐ "auth" layout: only when logged out; checks the server first,
 * /register    ┘ then follows connectivity changes by itself
 * /home        ┐ "app" layout (sidebar): only when logged in; pages read the session with useSession()
 * /database    ┘ backups and clearing the clinic database
 *
 * Pages read their route's data with getRouteApi("<route id>") instead of importing this file.
 */

const rootRoute = createRootRoute({ component: RootLayout });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: getSession() ? "/home" : "/login" });
  },
});

// --- Logged out -------------------------------------------------------------

const authRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "auth",
  beforeLoad: () => {
    if (getSession()) throw redirect({ to: "/home" });
  },
  // Which login screen to show. Checked on every visit to the login screen
  // (startup, after logout) and on "retry", not when switching login ↔ register.
  // The check goes through the connectivity store, so the header indicator shows it.
  // A new object every run, so the layout notices even an unchanged mode (see useLiveMode).
  loader: (): Promise<{ mode: ConnectionMode }> =>
    checkConnectivity()
      .then(() => connectionStatus(false))
      .catch((): ConnectionMode => "unavailable")
      .then((mode) => ({ mode })),
  staleTime: Infinity,
  gcTime: 0,
  pendingMs: 200,
  pendingComponent: CheckingConnection,
  component: AuthLayout,
});

const loginRoute = createRoute({
  getParentRoute: () => authRoute,
  path: "login",
  // ?registered=<username> after a successful sign-up, plus &setup=true after the clinic setup.
  validateSearch: (search: Record<string, unknown>): { registered?: string; setup?: true } => {
    if (typeof search.registered !== "string") return {};
    return search.setup === true ? { registered: search.registered, setup: true } : { registered: search.registered };
  },
  component: LoginPage,
});

const registerRoute = createRoute({
  getParentRoute: () => authRoute,
  path: "register",
  component: RegisterPage,
});

// --- Logged in --------------------------------------------------------------

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  beforeLoad: () => {
    if (!getSession()) throw redirect({ to: "/login" });
  },
  component: AppLayout,
});

const homeRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "home",
  component: HomePage,
});

const databaseRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "database",
  component: DatabasePage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  authRoute.addChildren([loginRoute, registerRoute]),
  appRoute.addChildren([homeRoute, databaseRoute]),
]);

export const router = createRouter({
  routeTree,
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
