import type { ReactNode } from 'react';
import { Phone, Mail } from 'lucide-react';

// The frame of the public chip-order pages (order, closed, tracking) — the
// 20/11/2026 design (ref/chip-order/chip-purchase-page-v2.html, DESIGN.md
// declared exception): a brand hero, white cards on #F4F5FA that overlap it,
// a 16px gutter on a phone. `chips-skin` stays on the root so the tracking and
// "closed" cards keep their --chip-* tokens. The support phone / email (the
// portal's own NEXT_PUBLIC_PORTAL_SUPPORT_*) are drawn only when configured.

function formatPhone(raw: string): string {
  const d = raw.replace(/\D/g, '');
  if (d.length === 9) return `${d.slice(0, 2)}-${d.slice(2, 5)}-${d.slice(5)}`;
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  return raw;
}

/** The reference's hero mark (inline, as drawn there). */
export function ChipOrderMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 4.1 12 6M5.1 8 2.8 10.3a3 3 0 0 0 0 4.2l6.7 6.7a3 3 0 0 0 4.2 0L16 19M15 9l6-6M9 15l6-6" />
    </svg>
  );
}

export function ChipOrderShell({
  subtitle, supportPhone, supportEmail, banner, notice, children,
}: {
  subtitle?: string;
  supportPhone?: string | null;
  supportEmail?: string | null;
  /** A strip pinned to the top of the viewport (test mode: "מצב בדיקה, אין חיוב"). */
  banner?: string;
  /** A note above the cards (Grow's sandbox: "סביבת בדיקות…"). */
  notice?: string;
  children: ReactNode;
}) {
  return (
    <div dir="rtl" className="chips-skin cr-skin">
      {banner && (
        <div role="status" data-testid="chip-order-test-banner" className="cr-strip">
          {banner}
        </div>
      )}
      <header className="cr-hero">
        <div className="cr-in">
          <span className="cr-hic"><ChipOrderMark /></span>
          <div>
            <h1>הזמנת כרטיסי בקרת כניסה</h1>
            <p>{subtitle ?? 'מגדלי חוף הכרמל — בניין אלמוג'}</p>
          </div>
        </div>
      </header>
      <main className="cr-wrap">
        {notice && <p role="status" className="cr-note">{notice}</p>}
        {children}
      </main>
      {(supportPhone || supportEmail) && (
        <footer className="cr-support">
          <span>לשאלות — חברת הניהול:</span>
          {supportPhone && (
            <a href={`tel:${supportPhone.replace(/\D/g, '')}`}>
              <Phone className="h-4 w-4" />
              <span className="cr-num">{formatPhone(supportPhone)}</span>
            </a>
          )}
          {supportEmail && (
            <a href={`mailto:${supportEmail}`}>
              <Mail className="h-4 w-4" />
              {supportEmail}
            </a>
          )}
        </footer>
      )}
    </div>
  );
}
