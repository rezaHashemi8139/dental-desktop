import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { connectionStatus, currentSession, type ConnectionMode, type Session } from "@/auth/session";
import { LanguageSwitcher } from "@/components/language-switcher";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { AuthPage } from "@/pages/auth-page";
import { HomePage } from "@/pages/home-page";

function App() {
  const { t } = useTranslation();
  // undefined = still checking whether someone is logged in.
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  // undefined = still checking the server and the local database.
  const [mode, setMode] = useState<ConnectionMode | undefined>(undefined);

  const checkConnection = useCallback(() => {
    setMode(undefined);
    connectionStatus()
      .then(setMode)
      .catch(() => setMode("unavailable"));
  }, []);

  useEffect(() => {
    currentSession()
      .then(setSession)
      .catch(() => setSession(null));
  }, []);

  // Check again on every visit to the login screen (startup and after logout).
  useEffect(() => {
    if (session === null) checkConnection();
  }, [session, checkConnection]);

  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex items-center justify-between gap-4 border-b px-4 py-2">
        <div>
          <h1 className="text-sm font-semibold" dir="ltr">
            {t("app.title")}
          </h1>
          <p className="text-xs text-muted-foreground">{t("app.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <ThemeSwitcher />
          <LanguageSwitcher />
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center p-6">
        {session === undefined ? null : session ? (
          <HomePage session={session} onLoggedOut={() => setSession(null)} />
        ) : (
          <AuthPage mode={mode} onRetry={checkConnection} onLoggedIn={setSession} />
        )}
      </main>
    </div>
  );
}

export default App;
