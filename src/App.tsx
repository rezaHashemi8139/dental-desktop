import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { LanguageSwitcher } from "@/components/language-switcher";
import { toRustMessage, translateMessage, type RustMessage } from "@/i18n/message";

function App() {
  const { t } = useTranslation();
  const [greetMsg, setGreetMsg] = useState<RustMessage | null>(null);
  const [name, setName] = useState("");
  const [testDbMsg, setTestDbMsg] = useState<RustMessage | null>(null);

  async function greet() {
    // Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
    try {
      setGreetMsg(await invoke<RustMessage>("greet", { name }));
    } catch (error) {
      setGreetMsg(toRustMessage(error));
    }
  }

  async function testDb() {
    try {
      setTestDbMsg(await invoke<RustMessage>("test_db_connection"));
    } catch (error) {
      setTestDbMsg(toRustMessage(error));
    }
  }

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{t("app.title")}</CardTitle>
          <CardDescription>{t("app.subtitle")}</CardDescription>
          <CardAction>
            <LanguageSwitcher />
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              greet();
            }}
          >
            <Input
              id="greet-input"
              onChange={(e) => setName(e.currentTarget.value)}
              placeholder={t("greet.placeholder")}
            />
            <Button type="submit">{t("greet.button")}</Button>
          </form>
          {greetMsg && <p className="text-sm">{translateMessage(greetMsg)}</p>}

          <Button variant="outline" onClick={testDb}>
            {t("database.testConnection")}
          </Button>
          {testDbMsg && (
            <p className="text-sm text-muted-foreground">{translateMessage(testDbMsg)}</p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

export default App;
