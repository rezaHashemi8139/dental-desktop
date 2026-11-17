import { Navigate, Outlet } from "@tanstack/react-router";
import { useSession } from "@/auth/store";

/**
 * Around every logged-in page. If the session ends by itself (the server revoked
 * access while the app was open), goes to the login screen, which says why.
 */
export function AppLayout() {
  const session = useSession();
  if (!session) return <Navigate to="/login" replace />;
  return <Outlet />;
}
