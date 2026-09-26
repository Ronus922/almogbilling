// scripts/bllink-shadow-report.ts — one-command view of the Bllink shadow scraper.
//   npm run bllink:shadow-report            # last 14 runs
//   npm run bllink:shadow-report -- 30      # last 30 runs
//   npm run bllink:shadow-report -- --diffs # also list every apartment/field difference
//
// Reads public.bllink_scrapes (written by scripts/bllink-scrape.ts) and prints,
// per run: date (Israel time), status, stage on failure, local vs CRM row counts,
// missing / extra apartments, field diffs, duration — plus the streak of
// consecutive clean runs against the Phase-2 pass criterion (5 runs, 0 diffs).
// DATABASE_URL comes from the environment or .env.local. Read-only.
import dotenv from 'dotenv';
import { Client } from 'pg';

// Local runs read .env.local (never overriding what the shell / systemd already set).
dotenv.config({ path: '.env.local', quiet: true });

const PASS_STREAK = 5;

interface Diff { apt: string; field: string; crm: unknown; local: unknown }
interface Summary {
  crm_rows?: number;
  local_rows?: number;
  crm_snapshot_at?: string | null;
  missing?: string[];
  extra?: string[];
  diffs?: Diff[];
  diff_count?: number;
  /** Who compared: 'scrape' (05:30, against what the CRM held then) or 'sync'
   *  (06:00, against the CRM's fresh report — the definitive one). */
  compared_by?: 'scrape' | 'sync';
  /** BLLINK_SOURCE=billing: the CRM could not be asked — a warning, not a failure. */
  compare?: 'unavailable';
  reason?: string;
}

const COMPARED_BY_LABEL: Record<string, string> = { scrape: 'סורק', sync: 'סנכרון' };
interface Row {
  id: string;
  started_at: Date;
  finished_at: Date | null;
  status: 'running' | 'success' | 'error';
  error_stage: string | null;
  error_message: string | null;
  rows_count: number | null;
  compare_summary: Summary | null;
}

const IL_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

function il(d: Date | null): string {
  return d ? IL_TIME.format(d).replace(',', '') : '—';
}

function duration(a: Date, b: Date | null): string {
  if (!b) return '—';
  return `${Math.round((b.getTime() - a.getTime()) / 1000)}s`;
}

function num(v: number | null | undefined): string {
  return v == null ? '—' : String(v);
}

function pad(v: string, w: number): string {
  return v.length >= w ? v : v + ' '.repeat(w - v.length);
}

function isClean(r: Row): boolean {
  return r.status === 'success' && (r.compare_summary?.diff_count ?? Number.NaN) === 0;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const showDiffs = args.includes('--diffs');
  const limitArg = args.find((a) => /^\d+$/.test(a));
  const limit = limitArg ? Number(limitArg) : 14;

  const url = (process.env.DATABASE_URL ?? '').trim();
  if (!url) throw new Error('DATABASE_URL is not set (env or .env.local)');
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    const { rows } = await db.query<Row>(
      `select id, started_at, finished_at, status, error_stage, error_message, rows_count, compare_summary
         from public.bllink_scrapes
        order by started_at desc
        limit $1`,
      [limit],
    );

    if (rows.length === 0) {
      console.log('אין עדיין ריצות של סורק-הצל (public.bllink_scrapes ריקה).');
      return;
    }

    const header = [
      pad('תאריך (IL)', 17), pad('סטטוס', 8), pad('שלב', 9), pad('מקומי', 6), pad('CRM', 5),
      pad('חסרות', 6), pad('עודפות', 7), pad('הפרשים', 7), pad('עד', 6), pad('משך', 5), 'מזהה',
    ].join(' ');
    console.log(header);
    console.log('-'.repeat(header.length + 24));

    for (const r of rows) {
      const s = r.compare_summary;
      console.log(
        [
          pad(il(r.started_at), 17),
          pad(r.status, 8),
          pad(r.error_stage ?? '—', 9),
          pad(num(r.rows_count), 6),
          pad(num(s?.crm_rows), 5),
          pad(num(s?.missing?.length), 6),
          pad(num(s?.extra?.length), 7),
          pad(num(s?.diffs?.length), 7),
          pad(s?.compared_by ? (COMPARED_BY_LABEL[s.compared_by] ?? s.compared_by) : '—', 6),
          pad(duration(r.started_at, r.finished_at), 5),
          r.id.slice(0, 8),
        ].join(' '),
      );
      if (r.status === 'error' && r.error_message) console.log(`    ↳ ${r.error_message.slice(0, 160)}`);
      if (s?.compare === 'unavailable') console.log(`    ↳ ה-CRM לא היה זמין להשוואה (אזהרה בלבד): ${(s.reason ?? '').slice(0, 160)}`);
      if (showDiffs && s) {
        if (s.missing?.length) console.log(`    חסרות במקומי (יש ב-CRM): ${s.missing.join(', ')}`);
        if (s.extra?.length) console.log(`    עודפות במקומי (אין ב-CRM): ${s.extra.join(', ')}`);
        for (const d of s.diffs ?? []) {
          console.log(`    דירה ${d.apt} · ${d.field}: CRM=${JSON.stringify(d.crm)} מקומי=${JSON.stringify(d.local)}`);
        }
      }
    }

    // Streak of consecutive clean runs, newest first (the Phase-2 pass criterion).
    let streak = 0;
    for (const r of rows) {
      if (r.status === 'running') continue;
      if (isClean(r)) streak++;
      else break;
    }
    console.log('');
    console.log(`ריצות נקיות רצופות (success + 0 הפרשים): ${streak}/${PASS_STREAK}`);
    const newest = rows[0];
    if (newest?.compare_summary?.crm_snapshot_at) {
      console.log(`snapshot ה-CRM שהושווה בריצה האחרונה: ${il(new Date(newest.compare_summary.crm_snapshot_at))} (IL)`);
    }
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(`bllink-shadow-report: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
