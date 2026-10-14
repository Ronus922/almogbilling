'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { axisLabel, balanceAxis, fmtIls, fmtSigned, niceAxis } from '@/lib/portal/ui';

// The overview's "הכנסות מול הוצאות" card (ref/almog-portal-overview): a
// hand-drawn SVG, three views behind the card's segmented control — bars,
// trend (polylines + gradient fill) and monthly balance (deviation from a
// zero line) — each animating in on mount (bars grow, lines draw in with
// stroke-dashoffset, dots pop, the balance bars grow from the zero line).
// Same geometry family as PortalBarChart (right-to-left X, niceAxis Y) but a
// SEPARATE component: PortalBarChart is shared with the transactions tab's
// period chart and the category-trend panel, which this redesign must not
// touch (DESIGN.md's "declared exception" scope).
//
// Touch parity (the dock round-2 lesson: a mouse-only trigger reads as "the
// animation doesn't work" on a phone): the entrance animations are plain
// rAF/CSS, not gated on `:hover`, so they run identically on touch. The
// tooltip opens on tap too — `matchMedia('(hover: hover)')` tells a real tap
// (toggles the tooltip) apart from a mouse click (still navigates to the
// month via `onPick`, the pre-existing behaviour).

export type OverviewChartView = 'bars' | 'area' | 'bal';

export interface OverviewChartMonth {
  key: string;
  label: string;
  income: number;
  expense: number;
}

const PL = 44;
const PB = 28;
const FALLBACK_W = 700;
const FALLBACK_H = 280;

function isTapLike(): boolean {
  return typeof window !== 'undefined' && !window.matchMedia('(hover: hover)').matches;
}

export function PortalOverviewChart({ months, view, onPick }: {
  months: readonly OverviewChartMonth[];
  view: OverviewChartView;
  onPick?: (key: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [go, setGo] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const [tapped, setTapped] = useState<number | null>(null);
  const gradId = useId();

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth || FALLBACK_W, h: el.clientHeight || FALLBACK_H });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Double rAF (the reference's own technique): paint the "entering" state
  // once, then flip `go` on the next frame so the CSS transitions this
  // triggers actually animate instead of jumping straight to their end state.
  useEffect(() => {
    let raf1 = 0; let raf2 = 0;
    raf1 = requestAnimationFrame(() => { raf2 = requestAnimationFrame(() => setGo(true)); });
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
  }, []);

  const W = size?.w ?? FALLBACK_W;
  const H = size?.h ?? FALLBACK_H;
  const n = months.length;
  const gw = n > 0 ? (W - PL) / n : W - PL;
  const bw = Math.min(18, gw * 0.28);
  const plotH = H - PB;
  const xOf = (i: number) => W - (i + 0.5) * gw;

  const active = tapped ?? hover;

  function pick(i: number, key: string) {
    if (isTapLike()) { setTapped((t) => (t === i ? null : i)); return; }
    onPick?.(key);
  }

  const common = (i: number, key: string) => ({
    className: 'grp',
    onMouseEnter: () => setHover(i),
    onMouseLeave: () => setHover((h) => (h === i ? null : h)),
    onClick: () => pick(i, key),
    role: onPick ? 'button' as const : undefined,
    tabIndex: onPick ? 0 : undefined,
  });

  function tipOf(i: number) {
    const m = months[i];
    if (!m) return null;
    const net = m.income - m.expense;
    return (
      <>
        <b>{m.label}</b>
        <br />הכנסות <span className="num in">{fmtIls(m.income)}</span>
        <br />הוצאות <span className="num out">{fmtIls(m.expense)}</span>
        <br />מאזן <span className={`num ${net >= 0 ? 'in' : 'out'}`}>{fmtSigned(net)}</span>
      </>
    );
  }

  const tipX = active !== null ? W - xOf(active) : 0;

  return (
    <div className="ovch" ref={box}>
      {size && (
        <svg viewBox={`0 0 ${W} ${H}`} style={{ direction: 'ltr' }} aria-hidden={months.length === 0}>
          {view === 'bal'
            ? <BalanceBody months={months} W={W} H={H} plotH={plotH} gw={gw} xOf={xOf} go={go} common={common} />
            : view === 'area'
              ? <AreaBody months={months} W={W} H={H} plotH={plotH} gw={gw} xOf={xOf} go={go} gradId={gradId} common={common} />
              : <BarsBody months={months} W={W} H={H} plotH={plotH} gw={gw} bw={bw} xOf={xOf} go={go} common={common} />}
        </svg>
      )}
      <div className={`tip${active !== null ? ' on' : ''}`} style={{ right: `${tipX}px`, top: '12px' }} aria-hidden>
        {active !== null && tipOf(active)}
      </div>
    </div>
  );
}

interface BodyProps {
  months: readonly OverviewChartMonth[];
  W: number; H: number; plotH: number; gw: number;
  xOf: (i: number) => number;
  go: boolean;
  common: (i: number, key: string) => Record<string, unknown>;
}

function Grid({ W, H, plotH, max, step, labelOf }: { W: number; H: number; plotH: number; max: number; step: number; labelOf: (v: number) => string }) {
  const lines: number[] = [];
  for (let v = 0; v <= max + 1e-9; v += step) lines.push(v);
  return (
    <>
      {lines.map((v) => {
        const y = H - PB - (v / max) * plotH;
        return (
          <g key={v}>
            <line x1={PL} x2={W} y1={y} y2={y} stroke="#EEF1F6" />
            <text x={0} y={y + 4} fontFamily="var(--font-inter), Inter, sans-serif" fontSize={11} fill="#94A3B8">{labelOf(v)}</text>
          </g>
        );
      })}
    </>
  );
}

/** The month label under a group — inside its `.grp` (not a separate pass),
 *  so a selector like `.ovch .grp text` finds it, matching the convention
 *  `.chart .grp` already uses on the transactions tab's period chart. */
function monthLabel(m: OverviewChartMonth, i: number, x: number, gw: number, H: number) {
  if (gw < 34 && i % 2 === 1) return null;
  return <text x={x} y={H - 8} textAnchor="middle" fontFamily="var(--font-heebo), Heebo, sans-serif" fontSize={12} fill="#64748B">{m.label}</text>;
}

function BarsBody({ months, W, H, plotH, gw, bw, xOf, go, common }: BodyProps & { bw: number }) {
  const axis = niceAxis(Math.max(0, ...months.flatMap((m) => [m.income, m.expense])));
  const yFor = (v: number) => (go ? (v / axis.max) * plotH : 0);
  return (
    <>
      <Grid W={W} H={H} plotH={plotH} max={axis.max} step={axis.step} labelOf={axisLabel} />
      {months.map((m, i) => {
        const x = xOf(i);
        const hIn = yFor(m.income);
        const hEx = yFor(m.expense);
        const delay = `${i * 40}ms`;
        return (
          <g key={m.key} {...common(i, m.key)} aria-label={`${m.label}: הכנסות ${fmtIls(m.income)}, הוצאות ${fmtIls(m.expense)}`}>
            <rect x={x - gw / 2} y={0} width={gw} height={H - PB} fill="transparent" />
            <rect
              x={x + 1} y={H - PB - hIn} width={bw} height={hIn} rx={4} fill="#3D5AFE"
              style={{ transition: 'height .7s cubic-bezier(.22,1,.36,1), y .7s cubic-bezier(.22,1,.36,1)', transitionDelay: delay }}
            />
            <rect
              x={x - bw - 1} y={H - PB - hEx} width={bw} height={hEx} rx={4} fill={m.expense > m.income ? '#E5484D' : '#FDA4A7'}
              style={{ transition: 'height .7s cubic-bezier(.22,1,.36,1), y .7s cubic-bezier(.22,1,.36,1)', transitionDelay: delay }}
            />
            {monthLabel(m, i, x, gw, H)}
          </g>
        );
      })}
    </>
  );
}

function AreaBody({ months, W, H, plotH, gw, xOf, go, gradId, common }: BodyProps & { gradId: string }) {
  const axis = niceAxis(Math.max(0, ...months.flatMap((m) => [m.income, m.expense])));
  const yOf = (v: number) => H - PB - (v / axis.max) * plotH;
  const incLine = useRef<SVGPolylineElement>(null);
  const expLine = useRef<SVGPolylineElement>(null);

  useEffect(() => {
    if (!go) return;
    for (const ref of [incLine, expLine]) {
      const el = ref.current;
      if (!el) continue;
      const len = el.getTotalLength();
      el.style.strokeDasharray = `${len}`;
      el.style.strokeDashoffset = `${len}`;
      // Force layout before the transition runs, else the browser collapses
      // the 0→len→0 sequence into a no-op (the reference's getBoundingClientRect() kick).
      el.getBoundingClientRect();
      el.style.transition = 'stroke-dashoffset .9s cubic-bezier(.4,0,.2,1)';
      el.style.strokeDashoffset = '0';
    }
  }, [go, W, H]);

  if (months.length === 0) return <Grid W={W} H={H} plotH={plotH} max={axis.max} step={axis.step} labelOf={axisLabel} />;

  const incPts = months.map((m, i) => `${xOf(i)},${yOf(m.income)}`);
  const expPts = months.map((m, i) => `${xOf(i)},${yOf(m.expense)}`);
  const fillPts = `${xOf(0)},${H - PB} ${incPts.join(' ')} ${xOf(months.length - 1)},${H - PB}`;

  return (
    <>
      <Grid W={W} H={H} plotH={plotH} max={axis.max} step={axis.step} labelOf={axisLabel} />
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3D5AFE" stopOpacity={0.18} />
          <stop offset="1" stopColor="#3D5AFE" stopOpacity={0} />
        </linearGradient>
      </defs>
      <polygon points={fillPts} fill={`url(#${gradId})`} style={{ opacity: go ? 1 : 0, transition: 'opacity .6s .4s' }} />
      <polyline ref={incLine} points={incPts.join(' ')} fill="none" stroke="#3D5AFE" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
      <polyline ref={expLine} points={expPts.join(' ')} fill="none" stroke="#F27D81" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
      {months.map((m, i) => (
        <circle key={`i-${m.key}`} cx={xOf(i)} cy={yOf(m.income)} r={go ? 3.5 : 0} fill="#fff" stroke="#3D5AFE" strokeWidth={2.5} style={{ transition: 'r .3s cubic-bezier(.34,1.56,.64,1)', transitionDelay: `${i * 45}ms` }} />
      ))}
      {months.map((m, i) => (
        <circle key={`e-${m.key}`} cx={xOf(i)} cy={yOf(m.expense)} r={go ? 3.5 : 0} fill="#fff" stroke="#F27D81" strokeWidth={2.5} style={{ transition: 'r .3s cubic-bezier(.34,1.56,.64,1)', transitionDelay: `${i * 45}ms` }} />
      ))}
      {months.map((m, i) => {
        const x = xOf(i);
        return (
          <g key={`h-${m.key}`} {...common(i, m.key)} aria-label={`${m.label}: הכנסות ${fmtIls(m.income)}, הוצאות ${fmtIls(m.expense)}`}>
            <rect x={x - gw / 2} y={0} width={gw} height={H - PB} fill="transparent" />
            {monthLabel(m, i, x, gw, H)}
          </g>
        );
      })}
    </>
  );
}

function BalanceBody({ months, W, H, plotH, gw, xOf, go, common }: BodyProps) {
  const axis = balanceAxis(Math.max(0, ...months.map((m) => Math.abs(m.income - m.expense))));
  const zeroY = H - PB - plotH / 2;
  const half = plotH / 2;
  const bw = Math.min(24, gw * 0.34);
  const labelOf = (v: number) => (v === 0 ? '0' : `${axisLabel(v)}`);
  const lines = [-axis.max, -axis.step, 0, axis.step, axis.max];
  return (
    <>
      {lines.map((v) => {
        const y = zeroY - (v / axis.max) * half;
        return (
          <g key={v}>
            <line x1={PL} x2={W} y1={y} y2={y} stroke={v === 0 ? '#CBD5E1' : '#EEF1F6'} strokeDasharray={v === 0 ? '4 3' : undefined} />
            <text x={0} y={y + 4} fontFamily="var(--font-inter), Inter, sans-serif" fontSize={11} fill="#94A3B8">{labelOf(v)}</text>
          </g>
        );
      })}
      {months.map((m, i) => {
        const x = xOf(i);
        const net = m.income - m.expense;
        const h = go ? Math.min(half, (Math.abs(net) / axis.max) * half) : 0;
        const positive = net >= 0;
        const y = positive ? zeroY - h : zeroY;
        return (
          <g key={m.key} {...common(i, m.key)} aria-label={`${m.label}: מאזן ${fmtSigned(net)}`}>
            <rect x={x - gw / 2} y={0} width={gw} height={H - PB} fill="transparent" />
            <rect
              x={x - bw / 2} y={y} width={bw} height={h} rx={4} fill={positive ? '#12A150' : '#E5484D'}
              style={{ transition: 'height .7s cubic-bezier(.22,1,.36,1), y .7s cubic-bezier(.22,1,.36,1)', transitionDelay: `${i * 40}ms` }}
            />
            {monthLabel(m, i, x, gw, H)}
          </g>
        );
      })}
    </>
  );
}
