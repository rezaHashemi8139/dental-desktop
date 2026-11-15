import { useState, type FormEvent } from "react";
import { LoaderCircleIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { login, type Session } from "@/auth/session";
import { toRustMessage, translateMessage, type RustMessage } from "@/i18n/message";
import { FormField } from "@/components/form-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

interface LoginFormProps {
  initialUsername?: string;
  notice?: string | null;
  onLoggedIn: (session: Session) => void;
}

export function LoginForm({ initialUsername = "", notice, onLoggedIn }: LoginFormProps) {
  const { t } = useTranslation();
  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<RustMessage | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onLoggedIn(await login(username, password));
    } catch (e) {
      setError(toRustMessage(e));
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
      {notice && !error && (
        <Alert>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{translateMessage(error)}</AlertDescription>
        </Alert>
      )}

      <FormField
        id="login-username"
        label={t("auth.fields.username")}
        value={username}
        onChange={(e) => setUsername(e.currentTarget.value)}
        autoComplete="username"
        autoFocus={!initialUsername}
        dir="ltr"
        required
      />
      <FormField
        id="login-password"
        type="password"
        label={t("auth.fields.password")}
        value={password}
        onChange={(e) => setPassword(e.currentTarget.value)}
        autoComplete="current-password"
        autoFocus={!!initialUsername}
        dir="ltr"
        required
      />

      <Button type="submit" disabled={busy || !username || !password}>
        {busy && <LoaderCircleIcon className="animate-spin" />}
        {busy ? t("auth.login.working") : t("auth.login.submit")}
      </Button>
    </form>
  );
}
