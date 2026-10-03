import 'server-only';
import { cookies } from 'next/headers';
import { PORTAL_SESSION_COOKIE } from '@/lib/constants/portal';
import { AuthorizationError } from '@/lib/auth/errors';
import { isActiveOwner, isMixedOwnerPhone } from '@/lib/db/portal/ownerPhones';
import { PORTAL_ACCOUNT_REVIEW_MESSAGE } from '@/lib/portal/ownership';
import { logPortalEvent } from '@/lib/db/portal/events';
import {
  createPortalSessionRow, findPortalSession, revokePortalSession,
  revokePortalSessionsForPhone,
} from '@/lib/db/portal/sessions';

// The owners-portal session guard — the /portal counterpart of requireActor().
// Two properties it must hold, and both come from it reading ONLY its own
// cookie and its own table:
//   • the staff cookie (almog_sid) opens nothing here;
//   • this cookie opens nothing outside /portal — getSession() never looks at it.
//
// Every authenticated request RE-CHECKS that the phone is still an active owner
// (isActiveOwner). That is what makes a sale close access on its own: remove the
// roster row (or switch it off) and the next request revokes the session and
// bounces to the login. No cron, no manual step.

export interface PortalSession {
  id: string;
  phoneE164: string;
}

/** Sets the session cookie after a verified code. No Max-Age — a session cookie,
 *  so closing the browser ends it; the 12-hour ceiling is enforced in SQL. */
export async function startPortalSession(args: {
  phoneE164: string;
  ip: string | null;
  userAgent: string | null;
}): Promise<PortalSession> {
  const { id, token } = await createPortalSessionRow(args);
  const store = await cookies();
  store.set(PORTAL_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    // path '/' — NOT '/portal': the login/logout endpoints live under
    // /api/portal/*, which is not under /portal, so a narrower path would keep
    // the cookie from ever reaching them. Being sent on staff requests is
    // harmless: nothing outside this module reads this cookie, and getSession()
    // reads only almog_sid. Isolation is a property of the CODE, not the path.
    path: '/',
  });
  return { id, phoneE164: args.phoneE164 };
}

/**
 * The live portal session, or null. Returns null — after revoking the row and
 * clearing the cookie — when the phone is no longer an active owner.
 */
export async function getPortalSession(): Promise<PortalSession | null> {
  const store = await cookies();
  const token = store.get(PORTAL_SESSION_COOKIE)?.value;
  if (!token) return null;

  const session = await findPortalSession(token);
  if (!session) return null;

  if (!(await isActiveOwner(session.phoneE164))) {
    // The phone stopped being an active owner while the session was open (a sale,
    // or the row switched off). Revoke in the DB — that is what actually closes
    // access — then log it, then try to clear the cookie.
    await revokePortalSessionsForPhone(session.phoneE164);
    await logPortalEvent({
      phoneE164: session.phoneE164,
      eventType: 'session_revoked',
      details: { reason: 'no_longer_active_owner' },
    });
    // Next only permits a cookie mutation in a Server Action or a Route Handler;
    // this same function also runs while a PAGE renders, where the call throws.
    // The throw must not become a 500 for the resident: the row is already
    // revoked, so returning null redirects them to the login and the stale
    // cookie is simply inert (and gets cleared on the next route handler).
    try {
      store.delete({ name: PORTAL_SESSION_COOKIE, path: '/' });
    } catch {
      /* page render — see above */
    }
    return null;
  }

  return session;
}

/**
 * Route-handler guard for every /api/portal/* endpoint that serves resident data.
 * Throws AuthorizationError(401) — the same contract as requireActor — so
 * authErrorResponse() turns it into a response unchanged.
 */
export async function requirePortalSession(): Promise<PortalSession> {
  const session = await getPortalSession();
  if (!session) throw new AuthorizationError('לא מחובר', 401);
  return session;
}

/**
 * The guard of every /api/portal/* endpoint that serves FINANCIAL data: a live
 * session (requirePortalSession) whose phone is not a mixed-owners phone
 * (lib/portal/ownership.ts — containment 03/10/2026). Such a phone gets 403
 * with the "we are updating your account" message and no figure at all.
 */
export async function requirePortalFinanceAccess(): Promise<PortalSession> {
  const session = await requirePortalSession();
  if (await isMixedOwnerPhone(session.phoneE164)) {
    throw new AuthorizationError(PORTAL_ACCOUNT_REVIEW_MESSAGE, 403);
  }
  return session;
}

/** Logout: revoke the row, clear the cookie, log it. */
export async function endPortalSession(): Promise<void> {
  const store = await cookies();
  const token = store.get(PORTAL_SESSION_COOKIE)?.value;
  if (token) {
    const phoneE164 = await revokePortalSession(token);
    if (phoneE164) {
      await logPortalEvent({ phoneE164, eventType: 'session_revoked', details: { reason: 'logout' } });
    }
  }
  // Always reached from the logout ROUTE handler, where this is permitted.
  store.delete({ name: PORTAL_SESSION_COOKIE, path: '/' });
}
