// scripts/bllink-scrape.ts — billing's own Bllink scraper.
//
// billing logs into Bllink itself, exports the "udnp" building-debt report as
// Excel (the Playwright sequence the CRM (almog) used to run), parses it with
// the app's own parseDebtorsWorkbook, and stores the RAW snapshot in
// public.bllink_scrapes / public.bllink_scrape_rows.
//
// It writes NOTHING to debtors / contacts / sync_runs / import_runs itself:
// /api/sync/bllink (billing-sync.timer, 06:00) copies THIS snapshot and refuses
// anything not from today. Since the CRM was torn down (06/10/2026) this scrape
// is the only source of public.debtors; until then each scrape was also compared
// with the CRM's snapshot (bllink_scrapes.compare_summary — kept on old rows,
// NULL on new ones).
//
// Runs as its own oneshot process (systemd: deploy/systemd/billing-bllink-scrape.service,
// timer 05:30 Asia/Jerusalem — thirty minutes BEFORE the sync; until 26/09/2026 it
// was 06:10, ten minutes after the CRM's run):
//   /usr/bin/node node_modules/tsx/dist/cli.mjs scripts/bllink-scrape.ts
// Manual run with the production env: sudo systemctl start billing-bllink-scrape.service
//
// Env (all from /etc/billing/billing.env): DATABASE_URL, DIRECT_URL, BLLINK_USER,
// BLLINK_PASSWORD, PLAYWRIGHT_BROWSERS_PATH, SETTINGS_ENC_KEY +
// ADMIN_ALERT_PHONE/BLLINK_ALERT_PHONE (WhatsApp alert on failure, best-effort —
// scripts/lib/admin-alert.ts).
//
// Failure = status 'error' with the stage (login/navigate/download/parse),
// a screenshot in /var/log/billing/bllink-scrape-<ts>.png, exit 1 (→ the unit's
// OnFailure= email + WhatsApp) and the script's own WhatsApp alert. The password
// is never logged.
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
import { round2, toText } from '../src/lib/sync/bllinkCompare';
import {
  EMPTY_CONTACTS, extractTenantContacts, extractTenantPeople, type ApartmentContacts, type ListPerson,
} from '../src/lib/sync/tenantList';
import { resolveScrapeConnection, tryAcquireScrapeLock } from '../src/lib/sync/scrapeLock';
import { sendAdminAlert } from './lib/admin-alert';

// Local runs read .env.local (never overriding what the shell / systemd already set).
dotenv.config({ path: '.env.local', quiet: true });

// ─── Constants ────────────────────────────────────────────────────────────────

type Stage = 'login' | 'navigate' | 'download' | 'parse';

const TAG = '[bllink:shadow]';
const REPORT_URL = 'https://app.bllink.co/reports/building-debt/udnp';
// Bllink's own resident list — the source of every CONTACT field since
// 30/09/2026 (names and phones as well as the addresses it gave from 29/09).
// The debt export above stays the source of truth for MONEY; its two identity
// cells — one person per apartment, often the tenant alone — are kept as the
// fallback for a run that loses this read.
const TENANT_LIST_URL = 'https://app.bllink.co/reports/tenant-list/udnp';
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
  /** Bllink's resident list, raw, per field — null when that read failed. */
  list: ApartmentContacts;
  raw: Record<string, unknown>;
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
 * parseDebtorsWorkbook gives the app's canonical parse (clean numbers). The
 * RAW cells — the name cell and the phone cell, like the CRM's owner_name /
 * phone_primary — come from the same worksheet through the shared
 * worksheetToMatrix, filtered with the parser's own rule (a row counts when
 * column A has text).
 *
 * owner_name is stored RAW on purpose (restored 29/09/2026): this table holds
 * the source snapshot in the CRM's naming, and the split into owner / tenant
 * belongs to the mapper both sources share (bllinkMap.mapSourceRow). Writing
 * the parser's already-split owner here would have fed a split value back into
 * the splitter on the next sync, and the tenant half — the one the queue now
 * proposes — would have been gone before anyone could see it.
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
      owner_name: toText(r[1]),
      phone_primary: toText(r[2]),
      total_debt: round2(p.total_debt),
      monthly_debt: round2(p.management_fees), // column E
      special_debt: round2(p.hot_water_debt), // column G
      management_months_raw: p.monthly_debt, // column F (text)
      notes: p.details, // column H
      // Filled from the resident list afterwards.
      list: { ...EMPTY_CONTACTS },
      raw: {
        col_A: r[0] ?? null, col_B: r[1] ?? null, col_C: r[2] ?? null, col_D: r[3] ?? null,
        col_E: r[4] ?? null, col_F: r[5] ?? null, col_G: r[6] ?? null, col_H: r[7] ?? null,
      },
    };
  });
  return { rows, skipped: parsed.skipped };
}

// ─── Bllink (Playwright) ──────────────────────────────────────────────────────

/** The CRM's proven login sequence (25/08/2026 selectors), carried over when billing took the scrape. */
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

/**
 * The resident list's payload, read off the page rather than requested
 * directly: the endpoint wants an Authorization header and a family of
 * x-bllink-* headers that only the app sets, and a bare GET on the same
 * cookies answers 502. Driving the screen is also exactly what the Excel
 * export above does, so there is one way in and not two.
 */
async function fetchTenantContacts(page: Page): Promise<{
  contacts: Map<string, ApartmentContacts>;
  people: Record<string, ListPerson[]>;
}> {
  const waiter = page.waitForResponse(
    (r) => r.request().method() === 'GET' && r.url().endsWith('/tenants') && r.status() === 200,
    { timeout: 45_000 },
  );
  await page.goto(TENANT_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const payload: unknown = await (await waiter).json();
  const byApt = extractTenantContacts(payload);
  if (byApt.size === 0) throw new Error('resident list returned no apartment with a contact');
  // Every person too, isActive kept — the portal links are compared per
  // person, by phone (portal_link_suggest, after the sync).
  return { contacts: byApt, people: extractTenantPeople(payload) };
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

  // DIRECT (port 5432) and not the pooler, because of the lock below —
  // see resolveScrapeConnection. A 20-second batch job has no business in
  // Supavisor's pool anyway.
  const conn = resolveScrapeConnection(process.env);
  const db = new Client({ connectionString: conn.connectionString });
  await db.connect();

  // One scrape at a time (27/09/2026). The timer and the dashboard's "סנכרן
  // עכשיו" both start this unit, and a hand-run `tsx scripts/bllink-scrape.ts`
  // bypasses systemd's coalescing entirely — two Bllink logins at once is how a
  // snapshot ends up half-written. Refused lock = exit 0 WITHOUT a run row:
  // the other process is already producing the snapshot we wanted, so this is a
  // skip, not a failure, and must not fire the unit's OnFailure alert. The
  // caller that asked for a fresh snapshot notices by checking finished_at.
  if (conn.lockable) {
    if (!(await tryAcquireScrapeLock(db))) {
      log('skipped: another Bllink scrape holds the lock — nothing scraped, no run row');
      await db.end().catch(() => undefined);
      return 0;
    }
  } else {
    log('warning: DIRECT_URL is not set — running WITHOUT the scrape lock (systemd coalescing only)');
  }

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
      `⚠️ סורק בלינק (billing) נכשל\n` +
      `שלב: ${failedStage}\n` +
      `שגיאה: ${message.slice(0, 300)}\n` +
      (shot ? `צילום מסך: ${shot}\n` : '') +
      `ריצה: ${scrapeId}`;
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

    // The addresses, off Bllink's resident list — the same signed-in session,
    // one screen away, before the browser goes. BEST-EFFORT on purpose: the
    // debt figures are what this unit exists for, and Bllink renaming a
    // screen must not stop them being copied. A failure leaves both columns
    // NULL, which the queue reads as "Bllink said nothing" — ours stands, no
    // suggestion is withdrawn, and tomorrow tries again.
    let contacts = new Map<string, ApartmentContacts>();
    let people: Record<string, ListPerson[]> | null = null;
    let tenantListOk = false;
    try {
      ({ contacts, people } = await fetchTenantContacts(page));
      tenantListOk = true;
      log(`resident list: contacts for ${contacts.size} apartments`);
    } catch (e) {
      log(`warning: resident list unavailable — names and phones fall back to the debt export for this run: ${redact(errorText(e), secrets)}`);
    }

    await browser.close();
    browser = null;
    page = null;

    // ── parse (+ store the raw snapshot) ──
    stage = 'parse';
    const { rows, skipped } = await workbookToScrapeRows(buffer);
    if (rows.length === 0) throw new Error('the report parsed to 0 rows');

    for (const r of rows) {
      r.list = contacts.get(r.apartment_number) ?? { ...EMPTY_CONTACTS };
    }

    await db.query('begin');
    try {
      for (const r of rows) {
        await db.query(
          `insert into public.bllink_scrape_rows
             (scrape_id, apartment_number, owner_name, phone_primary, total_debt, monthly_debt,
              special_debt, management_months_raw, notes,
              list_owner_name, list_owner_phone, list_owner_email,
              list_tenant_name, list_tenant_phone, list_tenant_email, raw)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)`,
          [
            scrapeId, r.apartment_number, r.owner_name, r.phone_primary, r.total_debt, r.monthly_debt,
            r.special_debt, r.management_months_raw, r.notes,
            r.list.owner_name, r.list.owner_phone, r.list.owner_email,
            r.list.tenant_name, r.list.tenant_phone, r.list.tenant_email,
            JSON.stringify(r.raw),
          ],
        );
      }
      await db.query(
        `update public.bllink_scrapes set tenant_list_ok = $2, list_people = $3::jsonb where id = $1`,
        [scrapeId, tenantListOk, people ? JSON.stringify(people) : null],
      );
      await db.query('commit');
    } catch (e) {
      await db.query('rollback').catch(() => undefined);
      throw e;
    }
    log(`parsed ${rows.length} rows (skipped ${skipped}) and stored them`);

    await db.query(
      `update public.bllink_scrapes
          set status = 'success', finished_at = now(), rows_count = $2, xlsx_sha256 = $3
        where id = $1`,
      [scrapeId, rows.length, sha256],
    );
    settled = true;
    log(`run=${scrapeId} status=success rows=${rows.length} took=${((Date.now() - t0) / 1000).toFixed(1)}s`);
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
