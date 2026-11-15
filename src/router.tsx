import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { connectionStatus, type ConnectionMode } from "@/auth/session";
import { getSession } from "@/auth/store";
import { RootLayout } from "@/pages/root-layout";
import { AuthLayout, CheckingConnection, LoginPage, RegisterPage } from "@/pages/auth-layout";
import { HomePage } from "@/pages/home-page";

/**
 * Pages. A desktop app has no address bar, so history lives in memory.
 *
 * /            → /home or /login
 * /login       ┐ "auth" layout: only when logged out; checks the server first
 * /register    ┘
 * /home        — "app" layout: only when logged in; the session is in route context
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
  loader: (): Promise<ConnectionMode> => connectionStatus().catch(() => "unavailable" as const),
  staleTime: Infinity,
  gcTime: 0,
  pendingMs: 200,
  pendingComponent: CheckingConnection,
  component: AuthLayout,
});

const loginRoute = createRoute({
  getParentRoute: () => authRoute,
  path: "login",
  // ?registered=<username> after a successful sign-up.
  validateSearch: (search: Record<string, unknown>): { registered?: string } =>
    typeof search.registered === "string" ? { registered: search.registered } : {},
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
    const session = getSession();
    if (!session) throw redirect({ to: "/login" });
    return { session };
  },
  component: Outlet,
});

const homeRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "home",
  component: HomePage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  authRoute.addChildren([loginRoute, registerRoute]),
  appRoute.addChildren([homeRoute]),
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
