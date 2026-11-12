import type { ReactNode } from 'react';
import { KeyRound, Phone, Mail } from 'lucide-react';

// The frame of the public chip-order pages — the chips skin (DESIGN "מודול
// צ׳יפים"): the module's header gradient, white section cards on the module
// background, a 16px gutter on a phone. The support phone / email (the portal's
// own NEXT_PUBLIC_PORTAL_SUPPORT_*) are drawn only when configured.

function formatPhone(raw: string): string {
  const d = raw.replace(/\D/g, '');
  if (d.length === 9) return `${d.slice(0, 2)}-${d.slice(2, 5)}-${d.slice(5)}`;
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  return raw;
}

export function ChipOrderShell({
  subtitle, supportPhone, supportEmail, banner, children,
}: {
  subtitle?: string;
  supportPhone?: string | null;
  supportEmail?: string | null;
  /** A strip pinned to the top of the viewport (test mode: "מצב בדיקה, אין חיוב"). */
  banner?: string;
  children: ReactNode;
}) {
  return (
    <div dir="rtl" className="chips-skin min-h-dvh bg-[var(--chip-bg)] text-[var(--chip-ink)]">
      {banner && (
        <div
          role="status"
          data-testid="chip-order-test-banner"
          className="sticky top-0 z-30 border-b border-[var(--chip-amber-border)] bg-[var(--chip-amber-soft)] px-4 py-3 pt-[max(12px,env(safe-area-inset-top))] text-center text-[14px] font-extrabold text-[var(--chip-amber-ink)]"
        >
          {banner}
        </div>
      )}
      <header className="bg-[image:var(--chip-header-gradient)] px-4 pb-16 pt-[max(28px,env(safe-area-inset-top))] text-white">
        <div className="mx-auto flex max-w-[720px] items-center gap-3">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-[14px] border border-white/25 bg-white/15">
            <KeyRound className="h-6 w-6" />
          </span>
          <div className="min-w-0">
            <h1 className="text-[23px] font-black tracking-[-0.02em] sm:text-[27px]">הזמנת צ׳יפים למעלית</h1>
            <p className="text-[13.5px] font-medium text-white/80">{subtitle ?? 'מגדלי חוף הכרמל — בניין אלמוג'}</p>
          </div>
        </div>
      </header>
      <main className="mx-auto -mt-10 flex max-w-[720px] flex-col gap-[18px] px-4 pb-10">{children}</main>
      {(supportPhone || supportEmail) && (
        <footer className="mx-auto flex max-w-[720px] flex-wrap items-center gap-x-5 gap-y-2 px-4 pb-[max(24px,env(safe-area-inset-bottom))] text-[13px] font-semibold text-[var(--chip-ink-muted)]">
          <span>לשאלות — חברת הניהול:</span>
          {supportPhone && (
            <a href={`tel:${supportPhone.replace(/\D/g, '')}`} className="inline-flex min-h-[44px] items-center gap-1.5 hover:text-[var(--chip-brand)]">
              <Phone className="h-4 w-4" />
              <span className="chip-num">{formatPhone(supportPhone)}</span>
            </a>
          )}
          {supportEmail && (
            <a href={`mailto:${supportEmail}`} className="inline-flex min-h-[44px] items-center gap-1.5 hover:text-[var(--chip-brand)]">
              <Mail className="h-4 w-4" />
              {supportEmail}
            </a>
          )}
        </footer>
      )}
    </div>
  );
}
