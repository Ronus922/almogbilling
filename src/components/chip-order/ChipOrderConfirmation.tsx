'use client';

// The confirmation screen of /chip-order (20/11/2026 design, `.confirm` of the
// reference): order number, the message, a summary (one line per person row,
// the chips to issue, what was paid), the building / management details, and a
// short confetti burst (skipped under prefers-reduced-motion).

import { useEffect } from 'react';
import { formatIlsAfter } from '@/lib/chipOrders/model';

export interface ConfirmedRow {
  apartment: string;
  name: string;
  role: 'owner' | 'tenant';
  qty: number;
}

/** The building / management block — static content of the reference. */
const BUILDING_DETAILS: { label: string; value: string; num?: boolean }[] = [
  { label: 'הבניין', value: 'מגדלי חוף הכרמל — בניין אלמוג, דוד אלעזר 10' },
  { label: 'חברת הניהול', value: 'להב יעדים בע"מ' },
  { label: 'מחלקת גבייה · 08:00–16:00', value: '04-8500184', num: true },
  { label: 'הנהלת הבניין · א׳–ה׳ 10:00–13:00', value: '04-8500184', num: true },
  { label: 'רונן משולם, מנהל בניין (דחוף בלבד)', value: '052-6628944', num: true },
  { label: 'מייל', value: 'lahav.yeadim@gmail.com', num: true },
];

const CONFETTI_COLORS = ['#3D5AFE', '#2149BA', '#FFC53D', '#0C7A37', '#FF6B6B', '#9C6BFF'];

function runConfetti(): () => void {
  if (typeof window === 'undefined') return () => {};
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return () => {};
  const cv = document.createElement('canvas');
  cv.setAttribute('aria-hidden', 'true');
  cv.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:999';
  cv.width = window.innerWidth;
  cv.height = window.innerHeight;
  document.body.appendChild(cv);
  const ctx = cv.getContext('2d');
  if (!ctx) {
    cv.remove();
    return () => {};
  }
  const ps = Array.from({ length: 140 }, () => ({
    x: Math.random() * cv.width,
    y: -20 - Math.random() * cv.height * 0.5,
    w: 6 + Math.random() * 6,
    h: 8 + Math.random() * 8,
    c: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
    vy: 2 + Math.random() * 3,
    vx: -1.5 + Math.random() * 3,
    r: Math.random() * Math.PI,
    vr: -0.1 + Math.random() * 0.2,
  }));
  const t0 = performance.now();
  let raf = 0;
  const frame = (t: number) => {
    ctx.clearRect(0, 0, cv.width, cv.height);
    for (const p of ps) {
      p.x += p.vx;
      p.y += p.vy;
      p.r += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (t - t0 < 4200) raf = requestAnimationFrame(frame);
    else cv.remove();
  };
  raf = requestAnimationFrame(frame);
  return () => {
    cancelAnimationFrame(raf);
    cv.remove();
  };
}

export function ChipOrderConfirmation({
  orderNumber, rows, total,
}: {
  orderNumber: number;
  rows: ConfirmedRow[];
  total: number;
}) {
  useEffect(() => {
    window.scrollTo({ top: 0 });
    return runConfetti();
  }, []);
  const chips = rows.reduce((s, r) => s + r.qty, 0);

  return (
    <div className="flex flex-col gap-4" data-testid="chip-order-confirmation">
      <section className="cr-cfcard">
        <span className="cr-cfic">
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </span>
        <h2>ההזמנה התקבלה בהצלחה</h2>
        <div className="cr-ordno">מספר הזמנה <b className="cr-num" data-testid="chip-order-confirmation-number">{orderNumber}</b></div>
        <p className="cr-msg">
          תודה על הזמנתך. הנהלת הבניין תבדוק ותאמת את הפרטים שמסרת, ועם אישור ההזמנה תישלח אליך הודעה על מועד איסוף הכרטיסים מעמדת השומר בלובי הבניין — בכל יום ובכל שעה, ללא תיאום מראש.
        </p>
        <div className="cr-cfsum">
          {rows.map((r, i) => (
            <div key={i}>
              <span>דירה <span className="cr-num">{r.apartment || '—'}</span> · {r.name} ({r.role === 'tenant' ? 'שוכר' : 'בעלים'})</span>
              <b><span className="cr-num">{r.qty}</span> כרטיסים</b>
            </div>
          ))}
          <div>
            <span>סה&quot;כ כרטיסים להנפקה</span>
            <b className="cr-num">{chips}</b>
          </div>
          <div className="cr-tt">
            <span>שולם</span>
            <b className="cr-num">{formatIlsAfter(total)}</b>
          </div>
        </div>
      </section>
      <section className="cr-bldg">
        <h3>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 21h18M5 21V7l7-4 7 4v14M9 9h1m4 0h1M9 13h1m4 0h1M9 17h1m4 0h1" />
          </svg>
          פרטי הבניין וההנהלה
        </h3>
        <div className="cr-bgrid">
          {BUILDING_DETAILS.map((d) => (
            <div key={d.label} className="cr-bitem">
              <span>{d.label}</span>
              <b className={d.num ? 'cr-num' : undefined}>{d.value}</b>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
