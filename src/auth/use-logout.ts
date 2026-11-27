import { useCallback, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { logout } from "./session";
import { setSession } from "./store";

/** Logs out and goes to the login screen; `busy` while Rust ends the session. */
export function useLogout(): { logOut: () => Promise<void>; busy: boolean } {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const logOut = useCallback(async () => {
    setBusy(true);
    try {
      await logout();
    } finally {
      // Clear first: the /login guard sends logged-in users back to /home.
      setSession(null);
      navigate({ to: "/login", replace: true });
    }
  }, [navigate]);
  return { logOut, busy };
}
