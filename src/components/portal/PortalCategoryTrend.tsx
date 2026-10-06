'use client';

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { FinKind } from '@/lib/constants/finance';
import type { ResidentCategoryMonth } from '@/lib/types/finance';
import { axisLabel, fmtIls, monthTitle, niceAxis, spansYears, trendMonthLabel } from '@/lib/portal/ui';

// What a category row of the transactions tab opens on (06/10/2026): the
// category's sum in each of the newest published months — up to 12, from
// /api/portal/finance/categories/[id]/monthly — whatever period the tab's
// picker is on. The row's own amount stays the picker's period.
//
// Lazy: nothing is requested until a row is opened for the first time, and a
// loaded trend is kept in memory for the life of the page (a refresh clears
// it), so re-opening a row — also after the period changed — costs nothing. A
// failed request is not kept: "נסה שוב", or the next opening, asks again.
//
// The chart is a hand-drawn SVG like PortalBarChart (no chart library), but its
// own: the time axis runs inside a dir="ltr" box, oldest on the left and newest
// on the right; one thin bar per month, rounded at the top only, in the soft
// tone of its kind (income --green-soft, expense --red-soft), the active bar
// in the full tone; a Y axis of niceAxis gridlines with compact labels (0 · 5K ·
// 10K · 20K, Inter); a short Hebrew month under each bar, with two year digits
// on every label once the window spans two years ("דצמ׳ 25"). Hover (a mouse)
// or a tap (touch / pen) shows the month's full amount in the portal's .tip.
// It is measured with a ResizeObserver, so it always fits the card — bars and
// labels shrink, labels thin out — and never scrolls the page sideways.

/** Loaded trends by category id — the page's memory (see above). */
const loaded = new Map<string, ResidentCategoryMonth[]>();

async function fetchTrend(categoryId: string): Promise<ResidentCategoryMonth[]> {
  const res = await fetch(`/api/portal/finance/categories/${encodeURIComponent(categoryId)}/monthly`, { credentials: 'include' });
  if (!res.ok) throw new Error(`category trend: ${res.status}`);
  const body = (await res.json()) as { months: ResidentCategoryMonth[] };
  return body.months;
}

type TrendState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; months: ResidentCategoryMonth[] };

export function PortalCategoryTrend({ categoryId, name, kind, preview }: {
  categoryId: string;
  name: string;
  kind: FinKind;
  /** The admin preview (/finance?view=resident) holds no portal session, so the
   *  portal API would refuse it — say so instead of failing. */
  preview: boolean;
}) {
  const [state, setState] = useState<TrendState>(() => {
    const months = loaded.get(categoryId);
    return months ? { status: 'ready', months } : { status: 'loading' };
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (preview || loaded.has(categoryId)) return;
    let live = true;
    fetchTrend(categoryId).then(
      (months) => {
        loaded.set(categoryId, months);
        if (live) setState({ status: 'ready', months });
      },
      () => {
        if (live) setState({ status: 'error' });
      },
    );
    return () => {
      live = false;
    };
  }, [categoryId, preview, attempt]);

  if (preview) return <p className="trend-msg">בתצוגה המקדימה הגרף אינו נטען — בעלי הדירות רואים אותו בפורטל.</p>;
  if (state.status === 'loading') return <p className="trend-msg wait" role="status">טוען…</p>;
  if (state.status === 'error') {
    return (
      <div className="trend-msg" role="alert">
        <span>
          לא ניתן לטעון את הגרף.
          <button type="button" onClick={() => { setState({ status: 'loading' }); setAttempt((a) => a + 1); }}>נסה שוב</button>
        </span>
      </div>
    );
  }
  if (state.months.every((m) => m.total === 0)) return <p className="trend-msg">אין נתונים להצגה</p>;
  return <TrendChart months={state.months} kind={kind} name={name} />;
}

const PL = 36; // the Y labels' column (left — the box is LTR)
const PB = 24; // the month labels' row
const PT = 8; // headroom over the top gridline
const FALLBACK_W = 320;
const FALLBACK_H = 180;

/** A bar rounded at the top only: radius 4, less when the bar is narrower or
 *  shorter than that. */
function barPath(x: number, top: number, width: number, bottom: number): string {
  const r = Math.min(4, width / 2, bottom - top);
  return `M${x} ${bottom}V${top + r}A${r} ${r} 0 0 1 ${x + r} ${top}H${x + width - r}A${r} ${r} 0 0 1 ${x + width} ${top + r}V${bottom}Z`;
}

function TrendChart({ months, kind, name }: { months: ResidentCategoryMonth[]; kind: FinKind; name: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [active, setActive] = useState<number | null>(null);

  // The observer reports the box once on observe() and on every resize after.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth || FALLBACK_W, h: el.clientHeight || FALLBACK_H }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const tone = kind === 'income' ? 'in' : 'out';
  const W = size?.w ?? FALLBACK_W;
  const H = size?.h ?? FALLBACK_H;
  const n = months.length;
  const axis = niceAxis(Math.max(0, ...months.map((m) => m.total)));
  const gw = (W - PL) / n;
  const bw = Math.max(4, Math.min(14, gw * 0.42));
  const bottom = H - PB;
  const yOf = (v: number) => bottom - (v / axis.max) * (bottom - PT);
  const xOf = (i: number) => PL + (i + 0.5) * gw;

  const grid: number[] = [];
  for (let v = 0; v <= axis.max + 1e-9; v += axis.step) grid.push(v);

  // Labels: smaller type in a narrow column, and every k-th one (counted from
  // the newest, which always keeps its label) when even that does not fit.
  const withYear = spansYears(months.map((m) => m.month));
  const fontSize = gw < 30 ? 11 : 12;
  const labelW = (withYear ? 7 : 4) * fontSize * 0.6 + 6;
  const every = Math.max(1, Math.ceil(labelW / gw));

  const hovered = active !== null ? months[active] : null;
  let tipStyle: CSSProperties | undefined;
  if (active !== null && hovered) {
    // Anchored so it stays inside the card: hugging the left edge in the left
    // third, the right edge in the right third, centred in between.
    const x = xOf(active);
    const top = `${Math.max(yOf(hovered.total) - 8, 0)}px`;
    if (x < W / 3) tipStyle = { left: `${Math.max(0, x - 20)}px`, top, transform: 'translateY(-100%)' };
    else if (x > (W * 2) / 3) tipStyle = { right: `${Math.max(0, W - x - 20)}px`, top, transform: 'translateY(-100%)' };
    else tipStyle = { left: `${x}px`, top, transform: 'translate(-50%, -100%)' };
  }

  return (
    <div className="trend" dir="ltr" ref={box} onPointerLeave={(e) => { if (e.pointerType === 'mouse') setActive(null); }}>
      {size && (
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${name} — ${n} החודשים המפורסמים האחרונים`}>
          {grid.map((v) => {
            const y = yOf(v);
            return (
              <g key={v}>
                <line x1={PL} x2={W} y1={y} y2={y} stroke="#EEF1F6" />
                <text x={0} y={y + 4} fontFamily="var(--font-inter), Inter, sans-serif" fontSize={11} fill="#94A3B8">{axisLabel(v)}</text>
              </g>
            );
          })}
          {months.map((m, i) => {
            const x = xOf(i);
            const top = yOf(m.total);
            return (
              <g
                key={m.month}
                className="tcol"
                data-month={m.month}
                onPointerEnter={(e) => { if (e.pointerType === 'mouse') setActive(i); }}
                onPointerUp={(e) => { if (e.pointerType !== 'mouse') setActive((a) => (a === i ? null : i)); }}
              >
                <rect x={x - gw / 2} y={0} width={gw} height={H} fill="transparent" />
                {m.total > 0 && <path className={`b ${tone}${active === i ? ' on' : ''}`} d={barPath(x - bw / 2, top, bw, bottom)} />}
                {(n - 1 - i) % every === 0 && (
                  <text x={x} y={H - 7} textAnchor="middle" fontFamily="var(--font-heebo), Heebo, sans-serif" fontSize={fontSize} fill="#64748B">
                    {trendMonthLabel(m.month, withYear)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
      {hovered && (
        <div className="tip on" dir="rtl" style={tipStyle} aria-hidden>
          <b>{monthTitle(hovered.month)}</b>
          <br />
          <span className={`num ${tone}`}>{fmtIls(hovered.total)}</span>
        </div>
      )}
    </div>
  );
}
