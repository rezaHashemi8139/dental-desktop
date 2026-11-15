import { getRouteApi, Navigate, Outlet, useLocation, useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { CloudOffIcon, LoaderCircleIcon, RefreshCwIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Session } from "@/auth/session";
import { setSession } from "@/auth/store";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LoginForm } from "./login-form";
import { RegisterForm } from "./register-form";

const authRoute = getRouteApi("/auth");
const loginRoute = getRouteApi("/auth/login");

/** Shown while the server is being checked. */
export function CheckingConnection() {
  const { t } = useTranslation();
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <LoaderCircleIcon className="size-4 animate-spin" />
      {t("auth.connection.checking")}
    </p>
  );
}

/** /login and /register: what's offered depends on whether the server is reachable. */
export function AuthLayout() {
  const { t } = useTranslation();
  const mode = authRoute.useLoaderData();
  const tab = useLocation({ select: (location) => (location.pathname === "/register" ? "register" : "login") });
  const navigate = useNavigate();

  if (mode === "unavailable") {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CloudOffIcon className="size-5" />
            {t("auth.connection.unavailableTitle")}
          </CardTitle>
          <CardDescription>{t("auth.connection.unavailable")}</CardDescription>
        </CardHeader>
        <CardContent>
          <RetryButton />
        </CardContent>
      </Card>
    );
  }

  if (mode === "offline") {
    // No server: sign-up is impossible, only users who logged in here before can log in.
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{t("auth.login.title")}</CardTitle>
          <CardDescription>{t("auth.login.description")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Alert>
            <CloudOffIcon />
            <AlertDescription>{t("auth.connection.offline")}</AlertDescription>
          </Alert>
          <Outlet />
          <RetryButton />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>{t(tab === "login" ? "auth.login.title" : "auth.register.title")}</CardTitle>
        <CardDescription>{t(tab === "login" ? "auth.login.description" : "auth.register.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Tabs value={tab} onValueChange={(value) => navigate({ to: value === "register" ? "/register" : "/login" })}>
          <TabsList className="w-full">
            <TabsTrigger value="login">{t("auth.tabs.login")}</TabsTrigger>
            <TabsTrigger value="register">{t("auth.tabs.register")}</TabsTrigger>
          </TabsList>
        </Tabs>
        <Outlet />
      </CardContent>
    </Card>
  );
}

/** Checks the server again (re-runs the route loader). */
function RetryButton() {
  const { t } = useTranslation();
  const router = useRouter();
  const loading = useRouterState({ select: (state) => state.isLoading });
  return (
    <Button variant="outline" className="w-full" onClick={() => router.invalidate()} disabled={loading}>
      {loading ? <LoaderCircleIcon className="animate-spin" /> : <RefreshCwIcon />}
      {t("auth.connection.retry")}
    </Button>
  );
}

export function LoginPage() {
  const { t } = useTranslation();
  const { registered } = loginRoute.useSearch();
  const navigate = useNavigate();

  function onLoggedIn(session: Session) {
    setSession(session);
    navigate({ to: "/home", replace: true });
  }

  return (
    <LoginForm
      // A new form (with the new username) after each sign-up.
      key={registered ?? ""}
      initialUsername={registered ?? ""}
      notice={registered ? t("auth.signUpSuccess") : null}
      onLoggedIn={onLoggedIn}
    />
  );
}

export function RegisterPage() {
  const mode = authRoute.useLoaderData();
  const navigate = useNavigate();

  // Sign-up needs the server.
  if (mode !== "online") return <Navigate to="/login" replace />;

  return <RegisterForm onRegistered={(username) => navigate({ to: "/login", search: { registered: username } })} />;
}
