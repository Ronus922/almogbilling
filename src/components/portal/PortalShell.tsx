'use client';

import { useEffect, useLayoutEffect, useRef, useState, useTransition, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { firstName, initials, isCompanyName, type PortalTab } from '@/lib/portal/ui';
import { AccountIcon, AlertIcon, BuildingGlyph, LogoutIcon } from './PortalIcons';
import { PortalMobileDock } from './PortalMobileDock';
import { usePortalHref } from './usePortalHref';

// The portal's chrome (ref/Tenant Portal.html #scrPortal, and from round 3 —
// 14/10/2026 — ref/almog-portal-overview's own header): the sticky top bar
// with the building block, the tab row and the user block, over a 1280px
// `.wrap`. ≤600px the tab row gives way to the floating mobile dock
// (PortalMobileDock, ref/mobile-bottom-nav, 14/10/2026) and the names give way
// to the avatar (portal.css); above 600px there is exactly ONE row behavior —
// no separate "tablet" stacking — the tab row itself shrinks and scrolls
// internally instead (below).
//
// Round 3 (14/10/2026): sliding pill + scroll-aware header, 1:1 to the new
// reference. The pill is one absolutely-positioned element inside `.nav`
// (not a background per button) that slides under the active tab —
// positioned imperatively via refs (not React state) so moving it never
// triggers a render, exactly like the reference's own movePill(). It is
// measured in useLayoutEffect (before paint) so there is no first-frame
// flash, repositioned on every tab change, on resize, and ~260ms after a
// scroll crosses the 40px shrink threshold (once the shrink transition has
// settled — the reference's own margin).
//
// This also fixes the bug round 2 shipped (Ronen could not find "דיווח על
// תקלה" on his own desktop): `.nav` used to be `flex:none` with no
// `min-width:0`, so its own `overflow-x:auto` could never actually engage —
// a classic flexbox "min-width:auto" trap. Below the exact width DESIGN.md
// had measured (1280px, BEFORE this item existed), the un-shrinkable nav
// simply pushed `.top-report`/`.me` past the visible header with no visible
// scrollbar. Now `.nav{flex:1 1 auto;min-width:0}` genuinely shrinks and
// scrolls within its own lane, so the fixed-width items after it (the report
// button, the user block) always have their space reserved — visible at
// every width above 600px, including the collapsed header.
//
// The active tab lives in the URL (`?tab=`), so a refresh keeps it, and a tab
// switch is a navigation: the page reloads only that tab's data. The other
// selections (`m`, `n`) are carried along untouched. Links are built by
// usePortalHref, so the same shell serves /portal and the admin preview
// mounted on /finance (which carries `view` and `apt`). "דיווח על תקלה" opens
// /portal/report (owners only, not the preview): >600px a distinct action
// item at the left end of the nav row (`.top-report`, never styled like a
// tab, outside the nav's own scroll lane so it can never be squeezed out);
// ≤600px the top-of-content button (`.pir-entry`) steps aside for the dock's
// own "פתח תקלה" quick action — EXCEPT for a restricted (blocked-phone) user,
// who has no dock at all (PortalMobileDock is `!restricted`-gated below), so
// `.pir-entry` stays exactly as it was for them, full width included.

const TABS: ReadonlyArray<{ key: PortalTab; label: string; soon?: boolean }> = [
  { key: 'ov', label: 'סקירה' },
  { key: 'tx', label: 'הכנסות והוצאות' },
  { key: 'fund', label: 'קרן שיפוצים' },
  { key: 'acc', label: 'החשבון שלי' },
  { key: 'dec', label: 'החלטות' },
  { key: 'bal', label: 'מאזנים' },
];

/** Who is signed in — the portal's one identity (lib/portal/identity.ts),
 *  never worked out here. A blocked phone: no name. The apartment/role list
 *  used to live here too (the header's second line, 27/09–17/10/2026) — it
 *  is gone from the header (below) and was never needed anywhere else: the
 *  identity's own apartments already drive "החשבון שלי" (PortalAccountView,
 *  getPortalMyAccount) independently of this type. */
export interface PortalUser {
  name: string | null;
}

export function PortalShell({ tab, apartments, user, preview = false, restricted = false, children }: {
  tab: PortalTab;
  /** How many apartments the building has (contacts). */
  apartments: number;
  user: PortalUser;
  /** The admin preview (/finance?view=resident): read-only, no logout. */
  preview?: boolean;
  /** A blocked phone (lib/portal/identity.ts): no tab row — every tab would
   *  show the same notice. The fault report and logout stay. */
  restricted?: boolean;
  children: ReactNode;
}) {
  const router = useRouter();
  const href = usePortalHref();
  const [pending, startTransition] = useTransition();
  const [leaving, setLeaving] = useState(false);
  const [shrink, setShrink] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);

  function movePill() {
    const nav = navRef.current;
    const pill = pillRef.current;
    if (!nav || !pill) return;
    const on = nav.querySelector<HTMLButtonElement>('button.on');
    if (!on) return;
    pill.style.left = `${on.offsetLeft}px`;
    pill.style.top = `${on.offsetTop}px`;
    pill.style.width = `${on.offsetWidth}px`;
    pill.style.height = `${on.offsetHeight}px`;
  }

  // Before paint, so the pill never flashes at (0,0) on the first frame.
  useLayoutEffect(() => { movePill(); });

  useEffect(() => {
    let scrollTimer: ReturnType<typeof setTimeout>;
    let resizeTimer: ReturnType<typeof setTimeout>;
    const onScroll = () => {
      setShrink(window.scrollY > 40);
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(movePill, 260);
    };
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(movePill, 150);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      clearTimeout(scrollTimer);
      clearTimeout(resizeTimer);
    };
  }, []);

  function go(next: PortalTab, type?: 'decision' | 'protocol') {
    // Same tab, no chip requested: a true no-op (the tab row's own clicks,
    // and the dock's dec/bal quick actions besides "החלטות"/"פרוטוקולים").
    // Same tab WITH a chip (round 2, 14/10/2026 — the dock's "החלטות" /
    // "פרוטוקולים" quick actions): navigate anyway, even from the dec tab
    // itself, so the chip actually changes.
    if (next === tab && !type) return;
    // A tab switch keeps the other selections (m, n, f) — they are read back
    // when their tab is opened again.
    startTransition(() => router.push(href({ tab: next, type: type ?? null })));
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

  // The identity block (17/10/2026): one line, "שלום, {first name}" — never
  // the full name and never the apartment/role list, which used to grow with
  // every apartment the signed-in phone holds and, for anyone with many, push
  // the building name and the tab row off-screen. That list is not lost —
  // it is "החשבון שלי" (PortalAccountView), one block per apartment with its
  // own role tag, exactly like before. No name, an empty name, or a company
  // record (isCompanyName — "חברת…" / "…בע"מ") → "שלום" alone: never a
  // company's first word standing in for a person's, and never a claimed
  // role. `.nm`'s own overflow:hidden + ellipsis (portal.css) covers the one
  // remaining way this could overflow — an unusually long first name.
  const greetingName = user.name && !isCompanyName(user.name) ? firstName(user.name) : null;
  const nm = greetingName ? `שלום, ${greetingName}` : 'שלום';

  return (
    <div className="portal-skin">
      <header className={`top${shrink ? ' shrink' : ''}`}>
        <div className="top-in">
          <div className="bld">
            <div className="lg"><BuildingGlyph /></div>
            <div>
              <b>בניין אלמוג, חיפה</b>
              <span><span className="num">{apartments}</span> דירות · ועד הבית</span>
            </div>
          </div>
          {!restricted && (
            <>
              <nav className="nav" aria-label="חלקי הפורטל" ref={navRef} style={pending ? { opacity: 0.7 } : undefined}>
                <span className="pill" ref={pillRef} aria-hidden />
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
              {!preview && (
                <Link href="/portal/report" className="top-report pbtn pbtn-secondary pbtn-sm">
                  <AlertIcon />דיווח על תקלה
                </Link>
              )}
            </>
          )}
          <div className="me">
            <div className="av" aria-hidden>{user.name ? initials(user.name) : <AccountIcon size={16} />}</div>
            <div className="nm">{nm}</div>
            {!preview && (
              <button type="button" className="pbtn pbtn-ghost pbtn-sm" onClick={logout} disabled={leaving} title="התנתקות" aria-label="התנתקות">
                <LogoutIcon />
              </button>
            )}
          </div>
        </div>
      </header>
      {!restricted && <PortalMobileDock tab={tab} onNavigate={go} preview={preview} />}
      <main className="wrap">
        {/* The fault report (/portal/report) above the content — ≤600px it is
            now REDUNDANT with the dock's "פתח תקלה" quick action and hidden
            (portal-report.css), except for a restricted user: no dock renders
            for them (below), so their copy stays visible and full-width,
            exactly as before round 2. >600px it is unchanged — the top-report
            nav item (above) is an ADDITION, not a replacement, there. Not in
            the admin preview: staff have no portal session. */}
        {!preview && (
          <div className={restricted ? 'pir-entry pir-entry-always' : 'pir-entry'}>
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
