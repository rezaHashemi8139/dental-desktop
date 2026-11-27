import { Navigate, Outlet } from "@tanstack/react-router";
import { useSession } from "@/auth/store";
import { AppSidebar } from "@/components/app-sidebar";
import { LockScreen } from "@/pages/lock-screen";
import { PageArea } from "@/pages/root-layout";

/**
 * Around every logged-in page: the sidebar on the start side (right in RTL) and
 * the page beside it. If the session ends by itself (the server revoked access
 * while the app was open), goes to the login screen, which says why. While the
 * session is locked, the lock screen replaces both.
 */
export function AppLayout() {
  const session = useSession();
  if (!session) return <Navigate to="/login" replace />;
  if (session.locked) return <LockScreen session={session} />;
  return (
    <>
      <AppSidebar />
      <PageArea>
        <Outlet />
      </PageArea>
    </>
  );
}
