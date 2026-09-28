'use client';

import { useState, useTransition, type ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { apartmentsLabel, initials, type PortalTab } from '@/lib/portal/ui';
import { BuildingGlyph, LogoutIcon } from './PortalIcons';

// The portal's chrome (ref/Tenant Portal.html #scrPortal): the sticky top bar
// with the building block, the tab row and the user block, over a 1280px
// `.wrap`. One row of 68px on the desktop; ≤1180px the tabs drop to their own
// scrollable row; ≤600px the names give way to the avatar (portal.css).
//
// The active tab lives in the URL (`?tab=`), so a refresh keeps it, and a tab
// switch is a navigation: the page reloads only that tab's data. The other
// selections (`m`, `r`, `n`) are carried along untouched.

const TABS: ReadonlyArray<{ key: PortalTab; label: string; soon?: boolean }> = [
  { key: 'ov', label: 'סקירה' },
  { key: 'tx', label: 'הכנסות והוצאות' },
  { key: 'fund', label: 'קרן שיפוצים' },
  { key: 'acc', label: 'החשבון שלי', soon: true },
  { key: 'dec', label: 'החלטות', soon: true },
  { key: 'rep', label: 'דוחות' },
];

export interface PortalUser {
  name: string | null;
  apartments: string[];
}

export function PortalShell({ tab, apartments, user, children }: {
  tab: PortalTab;
  /** How many apartments the building has (contacts). */
  apartments: number;
  user: PortalUser;
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [leaving, setLeaving] = useState(false);

  function go(next: PortalTab) {
    if (next === tab) return;
    const q = new URLSearchParams(sp.toString());
    q.set('tab', next);
    startTransition(() => router.push(`${pathname}?${q.toString()}`));
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
  const sub = user.name ? `${apartmentsLabel(user.apartments)} · בעל/ת דירה` : apartmentsLabel(user.apartments);

  return (
    <div className="portal-skin">
      <header className="top">
        <div className="top-in">
          <div className="bld">
            <div className="lg"><BuildingGlyph /></div>
            <div>
              <b>מגדלי חוף הכרמל — בניין אלמוג, חיפה</b>
              <span><span className="num">{apartments}</span> דירות · ועד הבית</span>
            </div>
          </div>
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
          <div className="me">
            <div className="av" aria-hidden>{initials(user.name)}</div>
            <div className="nm">{nm}<span>{sub}</span></div>
            <button type="button" className="pbtn pbtn-ghost pbtn-sm" onClick={logout} disabled={leaving} title="התנתקות" aria-label="התנתקות">
              <LogoutIcon />
            </button>
          </div>
        </div>
      </header>
      <main className="wrap">{children}</main>
    </div>
  );
}
