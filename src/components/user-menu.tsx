import { useState } from "react";
import { ChevronsUpDownIcon, LoaderCircleIcon, LockIcon, LogOutIcon, UserPenIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { lockSession, type Session } from "@/auth/session";
import { setSession } from "@/auth/store";
import { useLogout } from "@/auth/use-logout";
import { ProfileDialog } from "@/components/profile-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * The logged-in user, at the bottom of the sidebar. Opens a menu to edit the
 * profile, lock the app (the lock screen, src/pages/lock-screen.tsx) or log out,
 * after confirming. A restricted (billing-only) login cannot be locked: it has no
 * clinic data to protect.
 */
export function UserMenu({ session }: { session: Session }) {
  const { t } = useTranslation();
  const [profileOpen, setProfileOpen] = useState(false);
  const [logoutOpen, setLogoutOpen] = useState(false);

  async function lock() {
    try {
      setSession(await lockSession());
    } catch (e) {
      console.warn("Could not lock the app:", e);
    }
  }

  return (
    <>
      {/* Not modal: a dialog opened from an item would otherwise find the page still blocked. */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="h-auto w-full justify-start gap-2.5 px-2 py-2 text-start data-[state=open]:bg-muted"
            aria-label={t("account.menu.label")}
          >
            <UserAvatar session={session} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium">{session.fullName || session.username}</span>
              <span dir="ltr" className="truncate text-start text-xs font-normal text-muted-foreground">
                {session.username}
              </span>
            </span>
            <ChevronsUpDownIcon className="text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" className="w-(--radix-dropdown-menu-trigger-width)">
          <DropdownMenuItem onSelect={() => setProfileOpen(true)}>
            <UserPenIcon />
            {t("account.menu.editProfile")}
          </DropdownMenuItem>
          {!session.billing && (
            <DropdownMenuItem onSelect={lock}>
              <LockIcon />
              {t("account.menu.lock")}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setLogoutOpen(true)}>
            <LogOutIcon />
            {t("account.menu.logout")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ProfileDialog open={profileOpen} onOpenChange={setProfileOpen} />
      <LogoutDialog open={logoutOpen} onOpenChange={setLogoutOpen} />
    </>
  );
}

/** The first letter of the user's name, on the logo's colours. */
export function UserAvatar({ session, className }: { session: Session; className?: string }) {
  const initial = [...(session.fullName.trim() || session.username)][0]?.toUpperCase() ?? "";
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-brand-start to-brand-end text-sm font-semibold text-primary-foreground",
        className,
      )}
    >
      {initial}
    </span>
  );
}

/** Asks before logging out. */
function LogoutDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const { logOut, busy } = useLogout();
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("account.logout.title")}</DialogTitle>
          <DialogDescription>{t("account.logout.description")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={busy}>
              {t("account.logout.cancel")}
            </Button>
          </DialogClose>
          <Button variant="destructive" onClick={logOut} disabled={busy} autoFocus>
            {busy ? <LoaderCircleIcon className="animate-spin" /> : <LogOutIcon data-icon="inline-start" />}
            {busy ? t("account.logout.working") : t("account.logout.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
