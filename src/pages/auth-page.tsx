import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Session } from "@/auth/session";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LoginForm } from "./login-form";
import { RegisterForm } from "./register-form";

export function AuthPage({ onLoggedIn }: { onLoggedIn: (session: Session) => void }) {
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
