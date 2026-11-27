import { Link, type LinkProps } from "@tanstack/react-router";
import { CreditCardIcon, DatabaseIcon, HouseIcon, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSession } from "@/auth/store";
import { Button } from "@/components/ui/button";
import { version } from "../../package.json";

/**
 * Side navigation of the logged-in pages (src/router.tsx). Link marks the
 * current page with data-status="active". The clinic owner also has the
 * subscription page; a restricted login has nothing else. The app version is
 * shown at the bottom.
 */
export function AppSidebar() {
  const { t } = useTranslation();
  const session = useSession();
  const restricted = !!session?.billing;
  return (
    <aside className="flex w-60 shrink-0 flex-col overflow-y-auto border-e bg-muted/40 p-3">
      <nav aria-label={t("nav.label")} className="flex flex-col gap-1">
        {!restricted && <SidebarLink to="/home" icon={HouseIcon} label={t("nav.home")} />}
        {!restricted && <SidebarLink to="/database" icon={DatabaseIcon} label={t("nav.database")} />}
        {session?.isOwner && <SidebarLink to="/subscription" icon={CreditCardIcon} label={t("nav.subscription")} />}
      </nav>
      <p className="mt-auto pt-3 text-center text-xs text-muted-foreground">{t("settings.about.version", { version })}</p>
    </aside>
  );
}

function SidebarLink({ to, icon: Icon, label }: { to: LinkProps["to"]; icon: LucideIcon; label: string }) {
  return (
    <Button
      asChild
      variant="ghost"
      className="w-full justify-start data-[status=active]:bg-accent data-[status=active]:text-accent-foreground"
    >
      <Link to={to}>
        <Icon data-icon="inline-start" />
        {label}
      </Link>
    </Button>
  );
}
