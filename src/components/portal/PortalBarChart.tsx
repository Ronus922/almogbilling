'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { axisLabel, niceAxis } from '@/lib/portal/ui';

// The reference's drawChart(), as a component: a hand-drawn SVG — no chart
// library — with the same geometry (bottom pad 28, left pad 44, group width
// (W − 44) / n, bar width min(18, gw × 0.28), 4px radius), the same axis
// labels (Inter 11 #94A3B8), the same month labels (Heebo 12 #64748B, every
// second one when a group is narrower than 34px), the same tooltip (.tip,
// right-anchored on the group, top at the taller bar) and a redraw on resize
// (ResizeObserver on the .chart box, which is what the reference's resize
// listener achieved). The whole month column is the hit area: hover shows the
// tooltip, a click hands the month to `onPick`.

export interface ChartBar {
  value: number;
  fill: string;
}

export interface ChartPoint {
  key: string;
  label: string;
  /** Right to left inside the group (the reference draws income right of centre, expense left). */
  bars: ChartBar[];
  /** The tooltip lines under the month title. */
  tip: Array<{ label: string; value: string }>;
  /** An extra red line at the bottom of the tooltip — only when the month has one. */
  note?: string | null;
}

const PB = 28;
const PL = 44;
const FALLBACK_W = 700;
const FALLBACK_H = 240;

export function PortalBarChart({ points, onPick, ariaLabel }: {
  points: ChartPoint[];
  onPick?: (key: string) => void;
  ariaLabel: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth || FALLBACK_W, h: el.clientHeight || FALLBACK_H });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const W = size?.w ?? FALLBACK_W;
  const H = size?.h ?? FALLBACK_H;
  const n = points.length;
  const axis = niceAxis(Math.max(0, ...points.flatMap((p) => p.bars.map((b) => b.value))));
  const gw = n > 0 ? (W - PL) / n : W - PL;
  const bw = Math.min(18, gw * 0.28);
  const plot = H - PB - 8;
  const yOf = (v: number) => H - PB - (v / axis.max) * plot;

  const grid: number[] = [];
  for (let v = 0; v <= axis.max + 1e-9; v += axis.step) grid.push(v);

  const hovered = hover !== null ? points[hover] : null;
  const hoverX = hover !== null ? W - (hover + 0.5) * gw : 0;
  const hoverTop = hovered ? Math.min(yOf(Math.max(0, ...hovered.bars.map((b) => b.value))), H - 40) - 8 : 0;

  return (
    <div className="chart" ref={box}>
      {size && (
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel} style={{ direction: 'ltr' }}>
          {grid.map((v) => {
            const y = yOf(v);
            return (
              <g key={v}>
                <line x1={PL} x2={W} y1={y} y2={y} stroke="#EEF1F6" />
                <text x={0} y={y + 4} fontFamily="var(--font-inter), Inter, sans-serif" fontSize={11} fill="#94A3B8">{axisLabel(v)}</text>
              </g>
            );
          })}
          {points.map((p, i) => {
            const x = W - (i + 0.5) * gw;
            const showLabel = !(gw < 34 && i % 2 === 1);
            // Two bars sit either side of the centre (income right, expense
            // left); a single bar is centred on it.
            const xs = p.bars.length === 1 ? [x - bw / 2] : [x + 1, x - bw - 1];
            return (
              <g
                key={p.key}
                className="grp"
                data-i={i}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover((h) => (h === i ? null : h))}
                onClick={onPick ? () => onPick(p.key) : undefined}
                role={onPick ? 'button' : undefined}
                aria-label={onPick ? `${p.label}: ${p.tip.map((t) => `${t.label} ${t.value}`).join(', ')}` : undefined}
              >
                <rect x={x - gw / 2} y={0} width={gw} height={H - PB} fill="transparent" />
                {p.bars.map((b, k) => {
                  const h = (b.value / axis.max) * plot;
                  return <rect key={k} x={xs[k]} y={H - PB - h} width={bw} height={h} rx={4} fill={b.fill} />;
                })}
                {showLabel && (
                  <text x={x} y={H - 8} textAnchor="middle" fontFamily="var(--font-heebo), Heebo, sans-serif" fontSize={12} fill="#64748B">{p.label}</text>
                )}
              </g>
            );
          })}
        </svg>
      )}
      <div className={`tip${hovered ? ' on' : ''}`} style={{ right: `${W - hoverX}px`, top: `${hoverTop}px` }} aria-hidden>
        {hovered && (
          <>
            <b>{hovered.label}</b>
            {hovered.tip.map((t) => (
              <span key={t.label}><br />{t.label} <span className="num">{t.value}</span></span>
            ))}
            {hovered.note && <><br /><span className="note">{hovered.note}</span></>}
          </>
        )}
      </div>
    </div>
  );
}
