import { Link, type LinkProps } from "@tanstack/react-router";
import { ClockIcon, CreditCardIcon, DatabaseIcon, HouseIcon, UsersIcon, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSession } from "@/auth/store";
import { UserMenu } from "@/components/user-menu";
import { Button } from "@/components/ui/button";

/**
 * Side navigation of the logged-in pages (src/router.tsx). Link marks the
 * current page with data-status="active". The clinic owner also has the
 * subscription page; a restricted login has nothing else. The logged-in user
 * and their menu are at the bottom.
 */
export function AppSidebar() {
  const { t } = useTranslation();
  const session = useSession();
  const restricted = !!session?.billing;
  return (
    <aside className="flex w-60 shrink-0 flex-col overflow-y-auto border-e bg-muted/40 p-3">
      <nav aria-label={t("nav.label")} className="flex flex-col gap-1">
        {!restricted && <SidebarLink to="/home" icon={HouseIcon} label={t("nav.home")} />}
        {!restricted && <SidebarLink to="/patients" icon={UsersIcon} label={t("nav.patients")} />}
        {!restricted && <SidebarLink to="/work-hours" icon={ClockIcon} label={t("nav.workHours")} />}
        {!restricted && <SidebarLink to="/database" icon={DatabaseIcon} label={t("nav.database")} />}
        {session?.isOwner && <SidebarLink to="/subscription" icon={CreditCardIcon} label={t("nav.subscription")} />}
      </nav>
      {session && (
        <div className="mt-auto border-t pt-3">
          <UserMenu session={session} />
        </div>
      )}
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
