import { Navigate, Outlet } from "@tanstack/react-router";
import { useSession } from "@/auth/store";
import { AppSidebar } from "@/components/app-sidebar";
import { PageArea } from "@/pages/root-layout";

/**
 * Around every logged-in page: the sidebar on the start side (right in RTL) and
 * the page beside it. If the session ends by itself (the server revoked access
 * while the app was open), goes to the login screen, which says why.
 */
export function AppLayout() {
  const session = useSession();
  if (!session) return <Navigate to="/login" replace />;
  return (
    <>
      <AppSidebar />
      <PageArea>
        <Outlet />
      </PageArea>
    </>
  );
}
