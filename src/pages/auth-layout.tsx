import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { getRouteApi, Navigate, Outlet, useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import { CloudOffIcon, DatabaseIcon, InfoIcon, LoaderCircleIcon, RefreshCwIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useConnectivity } from "@/auth/connectivity";
import { connectionStatus, type ConnectionMode, type Session } from "@/auth/session";
import type { PendingSetup } from "@/auth/setup";
import { getEndedMessage, getEndedNotice, setSession } from "@/auth/store";
import type { RustMessage } from "@/i18n/message";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { PageArea } from "@/pages/root-layout";
import { ChangePasswordForm } from "./change-password-form";
import { ClinicSetup } from "./clinic-setup";
import { LoginForm } from "./login-form";
import { RegisterForm } from "./register-form";

const authRoute = getRouteApi("/auth");
const loginRoute = getRouteApi("/auth/login");

/** The login screen's current mode, for the pages inside it. */
const ModeContext = createContext<ConnectionMode>("online");

/** The login form as the clinic step left it: its username, and why logging in failed. */
interface BackFromSetup {
  username: string;
  error?: RustMessage;
}

/** Lets the login form hand over to the clinic step (first start), and come back from it. */
const SetupContext = createContext<{
  start: (setup: PendingSetup) => void;
  back: BackFromSetup | null;
  clearBack: () => void;
}>({ start: () => {}, back: null, clearBack: () => {} });

/** Shown while the server is being checked. */
export function CheckingConnection() {
  const { t } = useTranslation();
  return (
    <PageArea>
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircleIcon className="size-4 animate-spin" />
        {t("auth.connection.checking")}
      </p>
    </PageArea>
  );
}

/**
 * The mode from the route loader (startup, logout, "retry", setup done), then
 * kept up to date as connectivity changes: losing the server switches to offline
 * login, getting it back switches to online, without reloading the page. The
 * "setup" mode is never left by itself: offline login is impossible there anyway.
 */
function useLiveMode(): ConnectionMode {
  const loaded = authRoute.useLoaderData();
  const [mode, setMode] = useState(loaded.mode);
  const state = useConnectivity().status.state;

  // A new loader result (a new object every run) always wins.
  useEffect(() => setMode(loaded.mode), [loaded]);

  useEffect(() => {
    if (state === "checking") return;
    let current = true;
    connectionStatus(false).then(
      (next) => current && setMode((previous) => (previous === "setup" ? previous : next)),
      (e) => console.warn("Could not update the login screen:", e),
    );
    return () => {
      current = false;
    };
  }, [state]);

  return mode;
}

/**
 * /login and /register: what's offered depends on whether the server is reachable,
 * and on a computer that was never set up, the clinic setup comes first.
 */
export function AuthLayout() {
  return (
    <PageArea>
      <AuthScreen />
    </PageArea>
  );
}

function AuthScreen() {
  const { t } = useTranslation();
  const mode = useLiveMode();
  const tab = useLocation({ select: (location) => (location.pathname === "/register" ? "register" : "login") });
  const navigate = useNavigate();
  const router = useRouter();

  // First start, after logging in: the clinic this computer joins, in place of the login card.
  const [pending, setPending] = useState<PendingSetup | null>(null);
  const [back, setBack] = useState<BackFromSetup | null>(null);
  const clearBack = useCallback(() => setBack(null), []);

  if (pending) {
    return (
      <Card className="w-full max-w-2xl">
        <ClinicSetup
          setup={pending}
          onLoggedIn={(session) => {
            setSession(session);
            navigate({ to: "/home", replace: true });
          }}
          onCancel={() => {
            setBack({ username: pending.username });
            setPending(null);
          }}
          onLoginFailed={(error) => {
            setBack({ username: pending.username, error });
            setPending(null);
            // The computer is connected now: checking the server again leaves "setup".
            router.invalidate();
          }}
        />
      </Card>
    );
  }

  if (mode === "unavailable" || mode === "localDatabaseUnavailable") {
    const database = mode === "localDatabaseUnavailable";
    const Icon = database ? DatabaseIcon : CloudOffIcon;
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Icon className="size-5" />
            {t(database ? "auth.connection.localDatabaseUnavailableTitle" : "auth.connection.unavailableTitle")}
          </CardTitle>
          <CardDescription>
            {t(database ? "auth.connection.localDatabaseUnavailable" : "auth.connection.unavailable")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RetryButton />
        </CardContent>
      </Card>
    );
  }

  // Online and offline share this card, with the form in the same place, so a
  // switch between them keeps what was typed.
  const offline = mode === "offline";
  const register = !offline && tab === "register";
  const setupSteps = { start: setPending, back, clearBack };
  return (
    <ModeContext.Provider value={mode}>
      <SetupContext.Provider value={setupSteps}>
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>{t(register ? "auth.register.title" : "auth.login.title")}</CardTitle>
            <CardDescription>{t(register ? "auth.register.description" : "auth.login.description")}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {mode === "setup" && (
              // First start: logging in (after signing up, for a new account) leads to the clinic step.
              <Alert variant="info">
                <InfoIcon />
                <AlertTitle>{t("setup.title")}</AlertTitle>
                <AlertDescription>{t("setup.notConnected")}</AlertDescription>
              </Alert>
            )}
            {offline ? (
              // No server: sign-up is impossible, only users who logged in here before can log in.
              <Alert>
                <CloudOffIcon />
                <AlertDescription>{t("auth.connection.offline")}</AlertDescription>
              </Alert>
            ) : (
              <Tabs
                value={tab}
                onValueChange={(value) => navigate({ to: value === "register" ? "/register" : "/login" })}
              >
                <TabsList className="w-full">
                  <TabsTrigger value="login">{t("auth.tabs.login")}</TabsTrigger>
                  <TabsTrigger value="register">{t("auth.tabs.register")}</TabsTrigger>
                </TabsList>
              </Tabs>
            )}
            <Outlet />
            {offline && <RetryButton />}
          </CardContent>
        </Card>
      </SetupContext.Provider>
    </ModeContext.Provider>
  );
}

/** Keeps the retry spinner visible at least this long, so a fast answer is still seen as a check. */
const MIN_RETRY_SPIN_MS = 600;

/**
 * Checks the server again (re-runs the route loader). The icon spins until the
 * answer is in, including while a check started elsewhere (e.g. the watcher) runs.
 */
function RetryButton() {
  const { t } = useTranslation();
  const router = useRouter();
  const { checking } = useConnectivity();
  const [retrying, setRetrying] = useState(false);
  const busy = retrying || checking;

  async function retry() {
    setRetrying(true);
    try {
      // `sync` waits for the loader; without it the reload runs in the background and resolves at once.
      await Promise.all([
        router.invalidate({ sync: true }),
        new Promise((resolve) => setTimeout(resolve, MIN_RETRY_SPIN_MS)),
      ]);
    } finally {
      setRetrying(false);
    }
  }

  return (
    <Button variant="outline" className="w-full" onClick={retry} disabled={busy}>
      <RefreshCwIcon className={cn(busy && "animate-spin")} />
      {t("auth.connection.retry")}
    </Button>
  );
}

export function LoginPage() {
  const { t } = useTranslation();
  const { registered } = loginRoute.useSearch();
  const navigate = useNavigate();
  const setupSteps = useContext(SetupContext);
  // Why the last session ended by itself, if it did (src/auth/store.ts).
  const [ended] = useState(getEndedMessage);
  // Why the app itself logged out last, if it did (database cleared).
  const [endedNotice] = useState(getEndedNotice);
  // A login refused for a temporary password: its credentials, while a new one is chosen.
  const [temporary, setTemporary] = useState<{ username: string; password: string } | null>(null);
  // Back from choosing a new password, or from the clinic step: the login form starts again with this.
  const [afterChange, setAfterChange] = useState<{ username: string; changed: boolean; error?: RustMessage } | null>(
    () => setupSteps.back && { ...setupSteps.back, changed: false },
  );
  // Taken over above; not shown again on the next visit to this form.
  const { clearBack } = setupSteps;
  useEffect(clearBack, [clearBack]);

  function onLoggedIn(session: Session) {
    setSession(session);
    navigate({ to: "/home", replace: true });
  }

  if (temporary) {
    return (
      <ChangePasswordForm
        username={temporary.username}
        currentPassword={temporary.password}
        onLoggedIn={onLoggedIn}
        onSetupRequired={setupSteps.start}
        onBack={(changed, error) => {
          setAfterChange({ username: temporary.username, changed, error });
          setTemporary(null);
        }}
      />
    );
  }

  if (afterChange) {
    return (
      <LoginForm
        key="after-change"
        initialUsername={afterChange.username}
        notice={afterChange.changed ? t("auth.changePassword.changed") : null}
        initialError={afterChange.error ?? null}
        onLoggedIn={onLoggedIn}
        onSetupRequired={setupSteps.start}
        onPasswordChangeRequired={(username, password) => setTemporary({ username, password })}
      />
    );
  }

  return (
    <LoginForm
      // A new form (with the new username) after each sign-up.
      key={registered ?? ""}
      initialUsername={registered ?? ""}
      notice={registered ? t("auth.signUpSuccess") : endedNotice && t(endedNotice)}
      initialError={ended}
      onLoggedIn={onLoggedIn}
      onSetupRequired={setupSteps.start}
      onPasswordChangeRequired={(username, password) => setTemporary({ username, password })}
    />
  );
}

export function RegisterPage() {
  const mode = useContext(ModeContext);
  const navigate = useNavigate();

  // Sign-up needs the server.
  if (mode !== "online" && mode !== "setup") return <Navigate to="/login" replace />;

  return <RegisterForm onRegistered={(username) => navigate({ to: "/login", search: { registered: username } })} />;
}
