import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import type { RustMessage } from "@/i18n/message";
import { currentSession, type Session } from "./session";

/**
 * The logged-in user. Route guards read it in `beforeLoad` (src/router.tsx);
 * pages read it with `useSession()`, which follows changes Rust makes by itself:
 * - an offline session that reconnected becomes online (event "session");
 * - a session that ended by itself (the server revoked access, or too many wrong
 *   passwords for a database action) becomes null (event "session-ended"),
 *   and the app layout (src/pages/app-layout.tsx) then goes to the login screen.
 * Logging in and out change it together with a navigation (log in → /home, log out → /login).
 */
let session: Session | null = null;
/** Why the server ended the last session, shown on the login screen until someone logs in. */
let endedMessage: RustMessage | null = null;
const listeners = new Set<() => void>();

export function getSession(): Session | null {
  return session;
}

export function setSession(next: Session | null) {
  session = next;
  if (next) endedMessage = null;
  listeners.forEach((listener) => listener());
}

/** Why the server ended the last session, if it did. */
export function getEndedMessage(): RustMessage | null {
  return endedMessage;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSession(): Session | null {
  return useSyncExternalStore(subscribe, () => session);
}

/** Call once before the router starts. */
export async function loadSession(): Promise<void> {
  await listen<Session>("session", (event) => {
    // Only updates the session it belongs to.
    if (session && session.userId === event.payload.userId) setSession(event.payload);
  });
  await listen<RustMessage>("session-ended", (event) => {
    // Before notifying, so the login screen it leads to can show it.
    endedMessage = event.payload;
    setSession(null);
  });
  session = await currentSession().catch(() => null);
}
