'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ils } from '../format';

export interface ChartPoint {
  ym: string; // 'YYYY-MM' — stable per-bar key
  label: string;
  collection: number;
  debt: number;
  isCurrent: boolean;
  /** Pre-formatted collection-rate for the label + tooltip: "37%", or "—" for
   *  the baseline month (no opening balance to divide by). */
  rateLabel: string;
}

const COLLECTION = '#3d5afe'; // brand blue — נגבה בפועל
const DEBT = '#f59e0b'; // amber — יתרת חוב

interface TipProps {
  active?: boolean;
  label?: string | number;
  payload?: { name?: string; value?: number; color?: string; payload?: ChartPoint }[];
}

function ChartTooltip({ active, payload, label }: TipProps) {
  if (!active || !payload?.length) return null;
  const rateLabel = payload[0]?.payload?.rateLabel;
  return (
    <div dir="rtl" className="rounded-lg border border-line bg-white px-3 py-2 text-xs shadow-soft-md">
      <div className="mb-1 font-bold text-ink">{label}</div>
      {payload.map((p, i) => (
        <div key={i} className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-1.5 text-ink-2">
            <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
            {p.name}
          </span>
          <span className="font-num font-semibold text-ink">{ils(Number(p.value ?? 0))}</span>
        </div>
      ))}
      {rateLabel !== undefined && (
        <div className="mt-1 flex items-center justify-between gap-3 border-t border-line pt-1">
          <span className="text-ink-2">שיעור גבייה</span>
          <span className="font-num font-semibold text-ink">{rateLabel}</span>
        </div>
      )}
    </div>
  );
}

/**
 * RTL grouped bar chart: collection (brand) vs open debt (amber) per month.
 * recharts is LTR-internally, so the SVG is wrapped dir="ltr"; `reversed` on the
 * X axis makes months read right→left and the Y axis sits on the right — the RTL
 * reading the mockup shows. The current month's collection bar gets a dashed
 * outline. Until ~6 monthly snapshots accrue the series is partial (expected).
 */
export function CollectionChart({ data }: { data: ChartPoint[] }) {
  if (data.length === 0) {
    return (
      <div className="flex h-[260px] items-center justify-center text-center text-sm text-ink-3">
        אין עדיין נתוני גבייה — ייאספו עם כל ייבוא חודשי
      </div>
    );
  }
  return (
    <div dir="ltr" className="h-[260px] w-full">
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 16, right: 8, bottom: 4, left: 8 }} barGap={4} barCategoryGap="28%">
          <CartesianGrid vertical={false} stroke="#eef1f6" />
          <XAxis
            dataKey="label"
            reversed
            tickLine={false}
            axisLine={{ stroke: '#e2e7f0' }}
            tick={{ fontSize: 12, fill: '#64748b', fontWeight: 600 }}
          />
          <YAxis
            orientation="right"
            width={46}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11, fill: '#94a3b8' }}
            tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : `${v}`)}
          />
          <Tooltip cursor={{ fill: 'rgba(61,90,254,0.06)' }} content={<ChartTooltip />} />
          <Bar dataKey="collection" name="נגבה בפועל" fill={COLLECTION} radius={[6, 6, 0, 0]} maxBarSize={28}>
            {data.map((d) => (
              <Cell
                key={d.ym}
                fill={COLLECTION}
                stroke={d.isCurrent ? '#93c5fd' : undefined}
                strokeWidth={d.isCurrent ? 2 : 0}
                strokeDasharray={d.isCurrent ? '4 2' : undefined}
              />
            ))}
            {/* Collection-rate label above each collection bar ("37%" / "—"). */}
            <LabelList dataKey="rateLabel" position="top" offset={6} fill={COLLECTION} fontSize={11} fontWeight={700} />
          </Bar>
          <Bar dataKey="debt" name="יתרת חוב" fill={DEBT} radius={[6, 6, 0, 0]} maxBarSize={28} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
