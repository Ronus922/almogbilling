// scripts/bllink-scrape.ts — billing's own Bllink scraper.
//
// billing logs into Bllink itself, exports the "udnp" building-debt report as
// Excel (the same Playwright sequence the CRM runs in
// /var/www/almog-gmail/lib/jobs/bllink-sync.ts), parses it with the app's own
// parseDebtorsWorkbook, stores the RAW snapshot in public.bllink_scrapes /
// public.bllink_scrape_rows, and compares it — apartment by apartment — with
// the snapshot the CRM holds (CRM_DEBTORS_REST_URL, read-only).
//
// It writes NOTHING to debtors / contacts / sync_runs / import_runs itself.
// Who copies the snapshot into debtors depends on BLLINK_SOURCE (Phase 2,
// 26/09/2026): with `billing`, /api/sync/bllink (billing-sync.timer, 06:00)
// copies THIS snapshot and refuses anything not from today; with `crm` (the
// default) the CRM sync stays the writer and this is a shadow, as in Phase 1.
//
// Runs as its own oneshot process (systemd: deploy/systemd/billing-bllink-scrape.service,
// timer 05:30 Asia/Jerusalem — thirty minutes BEFORE the sync; until 26/09/2026 it
// was 06:10, ten minutes after the CRM's run):
//   /usr/bin/node node_modules/tsx/dist/cli.mjs scripts/bllink-scrape.ts
// Manual run with the production env: sudo systemctl start billing-bllink-scrape.service
//
// Env (all from /etc/billing/billing.env): DATABASE_URL, BLLINK_USER, BLLINK_PASSWORD,
// PLAYWRIGHT_BROWSERS_PATH, CRM_DEBTORS_REST_URL, CRM_DEBTORS_REST_KEY, BLLINK_SOURCE,
// SETTINGS_ENC_KEY + ADMIN_ALERT_PHONE/BLLINK_ALERT_PHONE (WhatsApp alert on
// failure, best-effort — scripts/lib/admin-alert.ts).
//
// Failure = status 'error' with the stage (login/navigate/download/parse/compare),
// a screenshot in /var/log/billing/bllink-scrape-<ts>.png, exit 1 (→ the unit's
// OnFailure= email + WhatsApp) and the script's own WhatsApp alert. The password
// is never logged.
//
// The compare stage is a WARNING, not a failure, when BLLINK_SOURCE=billing: the
// CRM is then only a witness, so a CRM that cannot be reached is recorded as
// `compare: unavailable` on a scrape that stays `success` — no alert. The
// definitive comparison of the morning is made by the sync at 06:00 (against
// the CRM's fresh report) and written over this one on the same row.
import dotenv from 'dotenv';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import { chromium, type Browser, type Page } from 'playwright';
import ExcelJS from 'exceljs';
import { parseDebtorsWorkbook, type ParsedDebtorRow } from '../src/lib/excel/parse';
import { toArrayBuffer, worksheetToMatrix } from '../src/lib/excel/workbook';
import {
  compareSnapshots, isCompareUnavailable, round2, toNum, toText,
  type CompareResult, type CompareRow,
} from '../src/lib/sync/bllinkCompare';
import { toCompareMap } from '../src/lib/sync/bllinkMap';
import { resolveBllinkSource } from '../src/lib/sync/decision';
import { sendAdminAlert } from './lib/admin-alert';

// Local runs read .env.local (never overriding what the shell / systemd already set).
dotenv.config({ path: '.env.local', quiet: true });

// ─── Constants ────────────────────────────────────────────────────────────────

type Stage = 'login' | 'navigate' | 'download' | 'parse' | 'compare';

const TAG = '[bllink:shadow]';
const REPORT_URL = 'https://app.bllink.co/reports/building-debt/udnp';
const TOTAL_TIMEOUT_MS = 180_000;
const RETENTION_DAYS = 90;
const LOG_DIR = '/var/log/billing';

// ─── Types ────────────────────────────────────────────────────────────────────

/** One row in the CRM debtor_records naming — what bllink_scrape_rows stores. */
interface ScrapeRow {
  apartment_number: string;
  owner_name: string | null;
  phone_primary: string | null;
  total_debt: number;
  monthly_debt: number;
  special_debt: number;
  management_months_raw: string | null;
  notes: string | null;
  raw: Record<string, unknown>;
}

interface CrmDebtorRecord {
  apartment_number: string | null;
  total_debt: number | null;
  monthly_debt: number | null;
  special_debt: number | null;
  management_months_raw: string | null;
  notes: string | null;
  last_import_at: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(msg: string): void {
  console.log(`${TAG} ${msg}`);
}

function requireEnv(name: string): string {
  const v = (process.env[name] ?? '').trim();
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Error text for the DB / journal / WhatsApp — never carries the password. */
function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s) out = out.split(s).join('•••');
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, 1000);
}

function stamp(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

// ─── Excel → rows (CRM naming) ────────────────────────────────────────────────

/**
 * parseDebtorsWorkbook gives the app's canonical parse (clean phones, numbers).
 * The raw eight cells (and the raw phone cell, like the CRM's phone_primary)
 * come from the same worksheet through the shared worksheetToMatrix, filtered
 * with the parser's own rule (a row counts when column A has text).
 */
async function workbookToScrapeRows(buffer: Buffer): Promise<{ rows: ScrapeRow[]; skipped: number }> {
  const parsed = await parseDebtorsWorkbook(buffer);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(toArrayBuffer(buffer));
  const sheet = wb.worksheets[0];
  const matrix = sheet ? worksheetToMatrix(sheet) : [];
  const rawRows = matrix.filter((r) => toText(r[0]) !== null);

  if (rawRows.length !== parsed.rows.length) {
    throw new Error(`raw/parsed row mismatch: raw=${rawRows.length} parsed=${parsed.rows.length}`);
  }

  const rows: ScrapeRow[] = parsed.rows.map((p: ParsedDebtorRow, i: number) => {
    const r = rawRows[i] ?? [];
    return {
      apartment_number: p.apartment_number,
      owner_name: p.owner_name,
      phone_primary: toText(r[2]),
      total_debt: round2(p.total_debt),
      monthly_debt: round2(p.management_fees), // column E
      special_debt: round2(p.hot_water_debt), // column G
      management_months_raw: p.monthly_debt, // column F (text)
      notes: p.details, // column H
      raw: {
        col_A: r[0] ?? null, col_B: r[1] ?? null, col_C: r[2] ?? null, col_D: r[3] ?? null,
        col_E: r[4] ?? null, col_F: r[5] ?? null, col_G: r[6] ?? null, col_H: r[7] ?? null,
      },
    };
  });
  return { rows, skipped: parsed.skipped };
}

// ─── CRM snapshot (read-only) ─────────────────────────────────────────────────

async function fetchCrmSnapshot(): Promise<{ byApt: Map<string, CompareRow>; snapshotAt: string | null }> {
  const base = requireEnv('CRM_DEBTORS_REST_URL').replace(/\/$/, '');
  const key = requireEnv('CRM_DEBTORS_REST_KEY');
  const select = 'apartment_number,total_debt,monthly_debt,special_debt,management_months_raw,notes,last_import_at';
  const url = `${base}?select=${select}&imported_this_run=eq.true&limit=10000`;

  const res = await fetch(url, { headers: { apikey: key, authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`CRM debtor_records fetch failed: HTTP ${res.status}`);
  const data = (await res.json()) as unknown;
  if (!Array.isArray(data)) throw new Error('CRM debtor_records returned a non-array payload');

  // Same dedupe rule as src/lib/sync/bllinkPull.ts: trimmed apartment, last wins.
  const byApt = new Map<string, CompareRow>();
  let snapshotAt: string | null = null;
  for (const r of data as CrmDebtorRecord[]) {
    const apt = toText(r.apartment_number);
    if (!apt) continue;
    byApt.set(apt, {
      total_debt: round2(toNum(r.total_debt)),
      monthly_debt: round2(toNum(r.monthly_debt)),
      special_debt: round2(toNum(r.special_debt)),
      management_months_raw: toText(r.management_months_raw),
      notes: toText(r.notes),
    });
    if (r.last_import_at && (snapshotAt === null || r.last_import_at > snapshotAt)) snapshotAt = r.last_import_at;
  }
  return { byApt, snapshotAt };
}

// ─── Bllink (Playwright) ──────────────────────────────────────────────────────

/** The CRM's proven sequence (almog-gmail lib/jobs/bllink-sync.ts, 25/08/2026 selectors). */
async function loginIfNeeded(page: Page, user: string, password: string): Promise<void> {
  await page.goto(REPORT_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  if (!page.url().includes('/login')) return;
  await page.locator('#login-email').fill(user);
  await page.locator('input[type="password"]').fill(password);
  // The form has a single submit button — selected structurally, not by label
  // (Bllink renamed the label on 25/08/2026 and broke the accessible-name selector).
  await page.locator('form button[type=submit]').click();
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 30_000 });
}

async function waitForReport(page: Page): Promise<void> {
  // Bllink polls in the background forever — wait for the report toolbar, not networkidle.
  await page.waitForSelector('.icons-bar', { timeout: 30_000 });
}

async function downloadExcel(page: Page, scrapeId: string): Promise<Buffer> {
  const exportIcon = page.locator('.icons-bar > img');
  await exportIcon.waitFor({ state: 'visible', timeout: 10_000 });
  await exportIcon.click();

  // The export dropdown flips visibility:hidden → visible; tolerate a miss.
  await page
    .waitForFunction(
      () => {
        const box = document.querySelector('.hidden-box');
        return box != null && window.getComputedStyle(box).visibility === 'visible';
      },
      undefined,
      { timeout: 10_000 },
    )
    .catch(() => undefined);

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    page.getByText('Excel').first().click(),
  ]);

  const tmpPath = path.join(os.tmpdir(), `bllink-shadow-${scrapeId}.xlsx`);
  try {
    await download.saveAs(tmpPath);
    return fs.readFileSync(tmpPath);
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
}

// ─── Retention ────────────────────────────────────────────────────────────────

async function pruneOldScrapes(db: Client): Promise<void> {
  // Our own table, designed policy: rows older than RETENTION_DAYS go (cascade → scrape_rows).
  const r = await db.query(
    `delete from public.bllink_scrapes where started_at < now() - ($1::int * interval '1 day')`,
    [RETENTION_DAYS],
  );
  if ((r.rowCount ?? 0) > 0) log(`retention: removed ${r.rowCount} scrape(s) older than ${RETENTION_DAYS} days`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const t0 = Date.now();
  const bllinkUser = requireEnv('BLLINK_USER');
  const bllinkPassword = requireEnv('BLLINK_PASSWORD');
  const secrets = [bllinkPassword];

  const db = new Client({ connectionString: requireEnv('DATABASE_URL') });
  await db.connect();

  const { rows: opened } = await db.query<{ id: string }>(
    `insert into public.bllink_scrapes default values returning id`,
  );
  const scrapeId = opened[0]!.id;
  log(`run=${scrapeId} started`);

  let stage: Stage = 'login';
  let browser: Browser | null = null;
  let page: Page | null = null;
  let settled = false;
  let exitCode = 0;

  const fail = async (err: unknown, failedStage: Stage): Promise<void> => {
    if (settled) return;
    settled = true;
    exitCode = 1;
    const message = redact(errorText(err), secrets);
    log(`run=${scrapeId} FAILED stage=${failedStage}: ${message}`);

    let shot: string | null = null;
    if (page && !page.isClosed()) {
      try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        shot = path.join(LOG_DIR, `bllink-scrape-${stamp()}.png`);
        await page.screenshot({ path: shot, fullPage: false, timeout: 10_000 });
        log(`screenshot: ${shot}`);
      } catch (e) {
        shot = null;
        log(`screenshot failed: ${redact(errorText(e), secrets)}`);
      }
    }

    try {
      await db.query(
        `update public.bllink_scrapes
            set status = 'error', finished_at = now(), error_stage = $2, error_message = $3
          where id = $1`,
        [scrapeId, failedStage, message],
      );
    } catch (e) {
      log(`could not record the failure: ${redact(errorText(e), secrets)}`);
    }

    const alert =
      `⚠️ סורק-הצל של בלינק (billing) נכשל\n` +
      `שלב: ${failedStage}\n` +
      `שגיאה: ${message.slice(0, 300)}\n` +
      (shot ? `צילום מסך: ${shot}\n` : '') +
      `ריצה: ${scrapeId}\n` +
      `הסנכרון הקיים מה-CRM לא הושפע.`;
    try {
      log((await sendAdminAlert(db, alert)).detail);
    } catch (e) {
      log(`WhatsApp alert threw: ${redact(errorText(e), secrets)}`);
    }
  };

  const watchdog = setTimeout(() => {
    void fail(new Error(`timeout: the whole run exceeded ${TOTAL_TIMEOUT_MS / 1000}s`), stage).finally(() => {
      void browser?.close().catch(() => undefined);
      void db.end().catch(() => undefined);
      process.exit(1);
    });
  }, TOTAL_TIMEOUT_MS);

  try {
    // ── login ──
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ acceptDownloads: true });
    page = await context.newPage();
    await loginIfNeeded(page, bllinkUser, bllinkPassword);
    log('login ok');

    // ── navigate ──
    stage = 'navigate';
    await waitForReport(page);
    log('report page ready');

    // ── download ──
    stage = 'download';
    const buffer = await downloadExcel(page, scrapeId);
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    log(`excel downloaded: ${buffer.length} bytes sha256=${sha256.slice(0, 12)}…`);
    await browser.close();
    browser = null;
    page = null;

    // ── parse (+ store the raw snapshot) ──
    stage = 'parse';
    const { rows, skipped } = await workbookToScrapeRows(buffer);
    if (rows.length === 0) throw new Error('the report parsed to 0 rows');
    await db.query('begin');
    try {
      for (const r of rows) {
        await db.query(
          `insert into public.bllink_scrape_rows
             (scrape_id, apartment_number, owner_name, phone_primary, total_debt, monthly_debt,
              special_debt, management_months_raw, notes, raw)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
          [
            scrapeId, r.apartment_number, r.owner_name, r.phone_primary, r.total_debt, r.monthly_debt,
            r.special_debt, r.management_months_raw, r.notes, JSON.stringify(r.raw),
          ],
        );
      }
      await db.query('commit');
    } catch (e) {
      await db.query('rollback').catch(() => undefined);
      throw e;
    }
    log(`parsed ${rows.length} rows (skipped ${skipped}) and stored them`);

    // ── compare with the snapshot the CRM holds ──
    stage = 'compare';
    const source = resolveBllinkSource(process.env.BLLINK_SOURCE);
    let summary: CompareResult;
    try {
      const crm = await fetchCrmSnapshot();
      summary = compareSnapshots(toCompareMap(rows), crm.byApt, {
        crmSnapshotAt: crm.snapshotAt, parseSkipped: skipped, comparedBy: 'scrape',
      });
    } catch (err) {
      // BLLINK_SOURCE=billing: the CRM is a witness, not the source — record the
      // absence as a warning and keep the scrape (the data path) a success.
      // BLLINK_SOURCE=crm: the comparison IS the point of a shadow scrape → fail.
      if (source !== 'billing') throw err;
      summary = {
        compare: 'unavailable', reason: redact(errorText(err), secrets), local_rows: rows.length,
        compared_by: 'scrape', compared_at: new Date().toISOString(),
      };
      log(`compare skipped — CRM unavailable (BLLINK_SOURCE=billing, warning only): ${summary.reason}`);
    }

    await db.query(
      `update public.bllink_scrapes
          set status = 'success', finished_at = now(), rows_count = $2, xlsx_sha256 = $3,
              compare_summary = $4::jsonb
        where id = $1`,
      [scrapeId, rows.length, sha256, JSON.stringify(summary)],
    );
    settled = true;

    if (isCompareUnavailable(summary)) {
      log(`run=${scrapeId} status=success local=${summary.local_rows} crm=unavailable took=${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } else {
      log(
        `run=${scrapeId} status=success local=${summary.local_rows} crm=${summary.crm_rows} ` +
          `missing=${summary.missing.length} extra=${summary.extra.length} field_diffs=${summary.diffs.length} ` +
          `crm_snapshot_at=${summary.crm_snapshot_at ?? '?'} took=${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );
      if (summary.missing.length) log(`missing in local (present in CRM): ${summary.missing.join(', ')}`);
      if (summary.extra.length) log(`extra in local (absent in CRM): ${summary.extra.join(', ')}`);
      for (const d of summary.diffs.slice(0, 50)) {
        log(`diff apt=${d.apt} ${d.field}: crm=${JSON.stringify(d.crm)} local=${JSON.stringify(d.local)}`);
      }
      if (summary.diffs.length > 50) log(`… ${summary.diffs.length - 50} more field diffs in compare_summary`);
    }
  } catch (err) {
    await fail(err, stage);
  } finally {
    clearTimeout(watchdog);
    if (browser) await browser.close().catch(() => undefined);
    try {
      await pruneOldScrapes(db);
    } catch (e) {
      log(`retention prune failed: ${redact(errorText(e), secrets)}`);
    }
    await db.end().catch(() => undefined);
  }
  return exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // Before the run row exists (env / DB connect) — nothing to record yet.
    console.error(`${TAG} fatal: ${redact(errorText(err), [process.env.BLLINK_PASSWORD ?? ''])}`);
    process.exit(1);
  });
