import { currentSession, type Session } from "./session";

/**
 * The logged-in user, as the router sees it. Route guards read it in
 * `beforeLoad` (src/router.tsx); pages get the session from route context.
 * Change it only together with a navigation (log in → /home, log out → /login).
 */
let session: Session | null = null;

export function getSession(): Session | null {
  return session;
}

export function setSession(next: Session | null) {
  session = next;
}

/** Call once before the router starts. */
export async function loadSession(): Promise<void> {
  session = await currentSession().catch(() => null);
}
