import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { currentSession, type Session } from "@/auth/session";
import { LanguageSwitcher } from "@/components/language-switcher";
import { AuthPage } from "@/pages/auth-page";
import { HomePage } from "@/pages/home-page";

function App() {
  const { t } = useTranslation();
  // undefined = still checking whether someone is logged in.
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    currentSession()
      .then(setSession)
      .catch(() => setSession(null));
  }, []);

  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex items-center justify-between gap-4 border-b px-4 py-2">
        <div>
          <h1 className="text-sm font-semibold" dir="ltr">
            {t("app.title")}
          </h1>
          <p className="text-xs text-muted-foreground">{t("app.subtitle")}</p>
        </div>
        <LanguageSwitcher />
      </header>

      <main className="flex flex-1 items-center justify-center p-6">
        {session === undefined ? null : session ? (
          <HomePage session={session} onLoggedOut={() => setSession(null)} />
        ) : (
          <AuthPage onLoggedIn={setSession} />
        )}
      </main>
    </div>
  );
}

export default App;
