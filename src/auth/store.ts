import { useSyncExternalStore } from "react";
import type { ParseKeys } from "i18next";
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
 * After an action that Rust ends with a logout (clearing the database), `sessionClosed`
 * empties it and the app layout goes to the login screen, which shows a notice.
 */
let session: Session | null = null;
/** Why the server ended the last session, shown on the login screen until someone logs in. */
let endedMessage: RustMessage | null = null;
/** Why the app itself logged out (`sessionClosed`), shown on the login screen until someone logs in. */
let endedNotice: ParseKeys | null = null;
const listeners = new Set<() => void>();

export function getSession(): Session | null {
  return session;
}

export function setSession(next: Session | null) {
  session = next;
  if (next) {
    endedMessage = null;
    endedNotice = null;
  }
  listeners.forEach((listener) => listener());
}

/** Why the server ended the last session, if it did. */
export function getEndedMessage(): RustMessage | null {
  return endedMessage;
}

/** Why the app itself logged out last, if it did: a translation key. */
export function getEndedNotice(): ParseKeys | null {
  return endedNotice;
}

/**
 * After an action Rust ended with a logout (the session is already closed there):
 * empties the session; the login screen then shows `notice`.
 */
export function sessionClosed(notice: ParseKeys) {
  endedNotice = notice;
  endedMessage = null;
  setSession(null);
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
    endedNotice = null;
    setSession(null);
  });
  session = await currentSession().catch(() => null);
}
