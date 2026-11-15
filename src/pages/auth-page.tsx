import { useState } from "react";
import { CloudOffIcon, LoaderCircleIcon, RefreshCwIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ConnectionMode, Session } from "@/auth/session";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LoginForm } from "./login-form";
import { RegisterForm } from "./register-form";

interface AuthPageProps {
  /** undefined while the connection is being checked. */
  mode: ConnectionMode | undefined;
  onRetry: () => void;
  onLoggedIn: (session: Session) => void;
}

export function AuthPage({ mode, onRetry, onLoggedIn }: AuthPageProps) {
  const { t } = useTranslation();

  if (mode === undefined) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircleIcon className="size-4 animate-spin" />
        {t("auth.connection.checking")}
      </p>
    );
  }

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
          <RetryButton onRetry={onRetry} />
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
          <LoginForm onLoggedIn={onLoggedIn} />
          <RetryButton onRetry={onRetry} />
        </CardContent>
      </Card>
    );
  }

  return <OnlineAuth onLoggedIn={onLoggedIn} />;
}

function RetryButton({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <Button variant="outline" className="w-full" onClick={onRetry}>
      <RefreshCwIcon />
      {t("auth.connection.retry")}
    </Button>
  );
}

/** Server reachable: log in or create an account. */
function OnlineAuth({ onLoggedIn }: { onLoggedIn: (session: Session) => void }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"login" | "register">("login");
  const [registeredUsername, setRegisteredUsername] = useState<string | null>(null);

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>{t(tab === "login" ? "auth.login.title" : "auth.register.title")}</CardTitle>
        <CardDescription>{t(tab === "login" ? "auth.login.description" : "auth.register.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs value={tab} onValueChange={(value) => setTab(value as typeof tab)} className="gap-4">
          <TabsList className="w-full">
            <TabsTrigger value="login">{t("auth.tabs.login")}</TabsTrigger>
            <TabsTrigger value="register">{t("auth.tabs.register")}</TabsTrigger>
          </TabsList>
          <TabsContent value="login">
            <LoginForm
              // Remount with the new username after a successful sign-up.
              key={registeredUsername ?? ""}
              initialUsername={registeredUsername ?? ""}
              notice={registeredUsername ? t("auth.signUpSuccess") : null}
              onLoggedIn={onLoggedIn}
            />
          </TabsContent>
          <TabsContent value="register">
            <RegisterForm
              onRegistered={(username) => {
                setRegisteredUsername(username);
                setTab("login");
              }}
            />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
