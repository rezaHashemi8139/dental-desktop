import { Navigate, Outlet } from "@tanstack/react-router";
import { useSession } from "@/auth/store";
import { AppSidebar } from "@/components/app-sidebar";
import { AuthBackdrop } from "@/components/auth-backdrop";
import { LockScreen } from "@/pages/lock-screen";
import { PageArea } from "@/pages/root-layout";

/**
 * Around every logged-in page: the sidebar on the start side (right in RTL) and
 * the page beside it, over the moving backdrop of the login screen (behind the
 * page only, not the sidebar or the header). If the session ends by itself (the
 * server revoked access while the app was open), goes to the login screen, which
 * says why. While the session is locked, the lock screen replaces both.
 */
export function AppLayout() {
  const session = useSession();
  if (!session) return <Navigate to="/login" replace />;
  if (session.locked) return <LockScreen session={session} />;
  return (
    <>
      <AppSidebar />
      {/* Its own stacking context, so the backdrop (z -10) stays above the page background;
          it stays put while the page scrolls inside PageArea. */}
      <div className="relative isolate flex min-w-0 flex-1">
        <AuthBackdrop />
        <PageArea>
          <Outlet />
        </PageArea>
      </div>
    </>
  );
}
