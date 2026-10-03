'use client';

import { useState, useTransition, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { apartmentsLabel, initials, type PortalTab } from '@/lib/portal/ui';
import { AlertIcon, BuildingGlyph, LogoutIcon } from './PortalIcons';
import { usePortalHref } from './usePortalHref';

// The portal's chrome (ref/Tenant Portal.html #scrPortal): the sticky top bar
// with the building block, the tab row and the user block, over a 1280px
// `.wrap`. One row of 68px on the desktop; ≤1180px the tabs drop to their own
// scrollable row; ≤600px the names give way to the avatar (portal.css).
//
// The active tab lives in the URL (`?tab=`), so a refresh keeps it, and a tab
// switch is a navigation: the page reloads only that tab's data. The other
// selections (`m`, `r`, `n`) are carried along untouched. Links are built by
// usePortalHref, so the same shell serves /portal and the admin preview
// mounted on /finance (which carries `view` and `apt`). The "דיווח על תקלה"
// button at the top of the content opens /portal/report (owners only, not the
// preview).

const TABS: ReadonlyArray<{ key: PortalTab; label: string; soon?: boolean }> = [
  { key: 'ov', label: 'סקירה' },
  { key: 'tx', label: 'הכנסות והוצאות' },
  { key: 'fund', label: 'קרן שיפוצים' },
  { key: 'acc', label: 'החשבון שלי' },
  { key: 'dec', label: 'החלטות', soon: true },
  { key: 'rep', label: 'דוחות' },
];

export interface PortalUser {
  name: string | null;
  apartments: string[];
}

export function PortalShell({ tab, apartments, user, preview = false, restricted = false, children }: {
  tab: PortalTab;
  /** How many apartments the building has (contacts). */
  apartments: number;
  user: PortalUser;
  /** The admin preview (/finance?view=resident): read-only, no logout. */
  preview?: boolean;
  /** A mixed-owners phone (containment 03/10/2026): no tab row — every tab
   *  would show the same notice. The fault report and logout stay. */
  restricted?: boolean;
  children: ReactNode;
}) {
  const router = useRouter();
  const href = usePortalHref();
  const [pending, startTransition] = useTransition();
  const [leaving, setLeaving] = useState(false);

  function go(next: PortalTab) {
    if (next === tab) return;
    // A tab switch keeps the other selections (m, r, n, f) — they are read
    // back when their tab is opened again.
    startTransition(() => router.push(href({ tab: next })));
  }

  async function logout() {
    if (leaving) return;
    setLeaving(true);
    try {
      await fetch('/api/portal/logout', { method: 'POST', credentials: 'include' });
      startTransition(() => router.replace('/portal/login'));
    } catch {
      toast.error('היציאה נכשלה');
      setLeaving(false);
    }
  }

  const nm = user.name ?? 'בעל/ת דירה';
  // No name and no apartment (a mixed-owners phone) → no second line, rather
  // than "בעל/ת דירה" twice.
  const sub = user.name
    ? `${apartmentsLabel(user.apartments)} · בעל/ת דירה`
    : user.apartments.length > 0 ? apartmentsLabel(user.apartments) : null;

  return (
    <div className="portal-skin">
      <header className="top">
        <div className="top-in">
          <div className="bld">
            <div className="lg"><BuildingGlyph /></div>
            <div>
              <b>בניין אלמוג, חיפה</b>
              <span><span className="num">{apartments}</span> דירות · ועד הבית</span>
            </div>
          </div>
          {!restricted && (
            <nav className="nav" aria-label="חלקי הפורטל" style={pending ? { opacity: 0.7 } : undefined}>
              {TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  className={t.key === tab ? 'on' : undefined}
                  aria-current={t.key === tab ? 'page' : undefined}
                  onClick={() => go(t.key)}
                >
                  {t.label}
                  {t.soon && <span className="soon">בקרוב</span>}
                </button>
              ))}
            </nav>
          )}
          <div className="me">
            <div className="av" aria-hidden>{initials(user.name)}</div>
            <div className="nm">{nm}{sub && <span>{sub}</span>}</div>
            {!preview && (
              <button type="button" className="pbtn pbtn-ghost pbtn-sm" onClick={logout} disabled={leaving} title="התנתקות" aria-label="התנתקות">
                <LogoutIcon />
              </button>
            )}
          </div>
        </div>
      </header>
      <main className="wrap">
        {/* The fault report (/portal/report) — opens every tab, labelled at
            every width (full-width on a phone). NOT in the top bar: its one
            row (building · six tabs · user) has ~114px to spare at 1280 with a
            short name and none with a real multi-apartment one (DESIGN.md).
            Not in the admin preview: staff have no portal session. */}
        {!preview && (
          <div className="pir-entry">
            <Link href="/portal/report" className="pbtn pbtn-primary pbtn-lg">
              <AlertIcon />דיווח על תקלה
            </Link>
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
