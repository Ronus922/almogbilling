import { test, expect, type Page } from '@playwright/test';
import { Pool } from 'pg';

// /portal/login end to end, through the screen a resident actually uses:
// the phone step, the WhatsApp code, and the states of ref/otp-states.md that
// decide whether someone gets in — wrong code, last attempt, lockout, expiry
// and resend.
//
// The code is read from scripts/e2e/greenapi-stub.mjs, the stand-in Green API
// the e2e stack points its one WhatsApp instance at. Nothing here mocks the
// app: the route issues a real bcrypt-hashed code, the stub carries it, and
// the form types it back in.
//
// THE REGRESSION THIS FILE GUARDS (29/09/2026): the boxes used to keep their
// digits after a wrong code and re-submit on EVERY keystroke of the
// correction, so one honest retype spent four of the five attempts and the
// resident was locked out "after two tries". "a correction costs ONE attempt"
// below is that bug, pinned.
//
// THE SECOND REGRESSION THIS FILE GUARDS (17/10/2026): the code field used to
// be six separate `maxLength={2}` boxes. Any route that injects the whole
// six-digit string at once into whichever single box happens to be focused —
// Android's own "use code" keyboard suggestion, iOS's QuickType chip — got
// silently truncated by that one box's maxLength, so autofill looked like it
// did nothing at all. There is now exactly one real field; "an OS-level
// autofill-style injection… fills the field" below is that bug, pinned.
//
// ROUND 2 (17/10/2026): the "הדבק קוד" button is gone — a second, redundant
// paste path, removed for the plain-OTP-screen look every other app uses.
// Its two tests (reading the clipboard itself; the visible empty-clipboard
// error) are gone with it. Native paste (a real `paste` event — long-press →
// Paste, or Ctrl+V) and the raw autofill-style injection are unaffected and
// still covered below.

test.use({ storageState: { cookies: [], origins: [] } });

const STUB = `http://127.0.0.1:${process.env.E2E_GREENAPI_PORT ?? 3110}`;
/** Seeded owners (db/seed/e2e.sql). Each test uses its own so a lockout in one
 *  cannot reach another. */
const DANA = { e164: '+972501111111', local: '050-111-1111', typed: '0501111111' };
const DAVID = { e164: '+972504444444', local: '050-444-4444', typed: '0504444444' };
const BENNY = { e164: '+972502222222', local: '050-222-2222', typed: '0502222222' };
const GALIT = { e164: '+972503333333', local: '050-333-3333', typed: '0503333333' };
// A phone per test: the 45-second server cooldown means reusing one inside a
// single run simply gets no second code.
const YOSSI = { e164: '+972501111112', local: '050-111-1112', typed: '0501111112' };
const RUTI = { e164: '+972502222223', local: '050-222-2223', typed: '0502222223' };
const MAYA = { e164: '+972503333334', local: '050-333-3334', typed: '0503333334' };
const ASAF = { e164: '+972504444445', local: '050-444-4445', typed: '0504444445' };
const NOT_AN_OWNER = '0509999999';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
pool.on('error', () => undefined);

const PHONES = [
  DANA.e164, DAVID.e164, BENNY.e164, GALIT.e164, YOSSI.e164, RUTI.e164, MAYA.e164, ASAF.e164,
  '+972509999999',
];

/**
 * The SEEDED portal sessions (db/seed/e2e.sql: e2e-owner-a1 and friends),
 * recorded before anything runs. Signing in here creates NEW sessions for the
 * same phones, and those are the only ones this file may remove: deleting by
 * phone alone takes the fixtures with them and leaves every later portal spec
 * staring at the login screen (iron rule 12, learned here the hard way).
 */
let seededSessionIds: string[] = [];

async function resetPhones() {
  await pool.query(`delete from public.portal_otp_codes where phone_e164 = any($1::text[])`, [PHONES]);
  await pool.query(`delete from public.portal_lockouts where phone_e164 = any($1::text[])`, [PHONES]);
  await pool.query(
    `delete from public.portal_sessions
      where phone_e164 = any($1::text[]) and not (id = any($2::uuid[]))`,
    [PHONES, seededSessionIds],
  );
  await pool.query(`delete from public.auth_rate_limits where bucket like 'portal:%'`);
  await fetch(`${STUB}/__reset`, { method: 'POST' });
}

test.beforeAll(async () => {
  const seeded = await pool.query<{ id: string }>(
    `select id from public.portal_sessions where phone_e164 = any($1::text[])`, [PHONES]);
  seededSessionIds = seeded.rows.map((r) => r.id);
  await resetPhones();
});
test.afterAll(async () => { await resetPhones(); await pool.end(); });

/** The six digits the stub was handed for this phone, newest last. */
async function codeFor(e164: string): Promise<string> {
  const chatId = `${e164.replace('+', '')}@c.us`;
  const res = await fetch(`${STUB}/__messages?chatId=${encodeURIComponent(chatId)}`);
  const { messages } = (await res.json()) as { messages: Array<{ message: string }> };
  const last = messages.at(-1);
  if (!last) throw new Error(`no WhatsApp message for ${e164}`);
  const m = last.message.match(/(\d{6})/);
  if (!m) throw new Error(`no 6-digit code in: ${last.message}`);
  return m[1]!;
}

/** The one real field (17/10/2026 — one `<input>`, not six boxes). The six
 *  cells still rendered behind it are decoration (`aria-hidden`, `data-testid
 *  "otp-cell"`) and carry no accessible name of their own. */
const codeField = (page: Page) => page.getByLabel('קוד בן 6 ספרות');

/**
 * `n` distinct six-digit codes, none of them the real one. They have to differ
 * from each other: re-submitting the very same digits is suppressed on purpose
 * (the answer cannot change), so a test that typed one code twice would be
 * measuring that guard rather than the attempt counter.
 */
function wrongCodes(real: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 100000; out.length < n; i += 111111) {
    const c = String(i).padStart(6, '0').slice(0, 6);
    if (c !== real && !out.includes(c)) out.push(c);
  }
  return out;
}

/** Types a code into the one field the way a person does — one keystroke at
 *  a time, so the auto-submit-on-the-sixth-digit path is exercised for real
 *  typing, not just a single programmatic `.fill()`. */
async function typeCode(page: Page, code: string) {
  await codeField(page).pressSequentially(code);
}

/** Types a number on step 1 and presses "שלח קוד אימות". */
async function sendCode(page: Page, typed: string) {
  await page.getByLabel('מספר טלפון').fill(typed);
  await page.getByRole('button', { name: /^שלח קוד אימות/ }).click();
}

/** Step 1 → step 2. Returning only once the code step is on screen is also
 *  what guarantees the server has finished sending, so the stub already holds
 *  the message by the time a test reads it. */
async function requestCode(page: Page, typed: string) {
  await page.goto('/portal/login');
  await sendCode(page, typed);
  await expect(page.getByRole('heading', { name: 'הזנת קוד' })).toBeVisible();
}

test.describe('portal login — the whole flow', () => {
  test('phone → code in WhatsApp → typed back → inside the portal', async ({ page }) => {
    await requestCode(page, DANA.typed);

    // The code step of the reference: title, the number on its own line with
    // the WhatsApp badge, the validity line, six boxes, a resend timer.
    await expect(page.getByRole('heading', { name: 'הזנת קוד' })).toBeVisible();
    await expect(page.getByText(DANA.local)).toBeVisible();
    await expect(page.getByText('הקוד תקף ל-5 דקות')).toBeVisible();
    await expect(page.getByTestId('otp-cell')).toHaveCount(6);
    await expect(page.getByText('שליחה חוזרת בעוד')).toBeVisible();
    // 01 — the button is disabled until six digits are in.
    await expect(page.getByRole('button', { name: 'כניסה לפורטל' })).toBeDisabled();
    // The field offers the OS the one-time code.
    await expect(codeField(page)).toHaveAttribute('autocomplete', 'one-time-code');
    // 17/10/2026, round 2: focused the instant the screen mounts — no tap
    // needed to open the numeric keyboard — and no separate paste button.
    await expect(codeField(page)).toBeFocused();
    await expect(page.getByRole('button', { name: 'הדבק קוד' })).toHaveCount(0);

    const code = await codeFor(DANA.e164);
    await typeCode(page, code);

    // 03 / 04 / 05 — the sixth digit verifies by itself, and the portal opens.
    await page.waitForURL('**/portal');
    await expect(page.locator('.nav button.on')).toHaveText('סקירה');
    // The session really is Dana's: her apartment, not anybody else's.
    await page.goto('/portal?tab=acc');
    await expect(page.locator('#t-acc')).toContainText('E2E-A');
  });

  test('a whole code pasted into the field fills it and verifies itself', async ({ page }) => {
    await requestCode(page, BENNY.typed);
    const code = await codeFor(BENNY.e164);
    await codeField(page).click();
    // The paste event itself, which is what the component listens for —
    // clipboard permissions differ too much between environments to rely on.
    await codeField(page).evaluate((el, c) => {
      const dt = new DataTransfer();
      dt.setData('text', c);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, code);
    await page.waitForURL('**/portal');
  });

  test('pasting the WHOLE WhatsApp message (not just the bare code) still fills and verifies', async ({ page }) => {
    // 15/10/2026: extractOtpCode must pull the one 6-digit run out of real
    // surrounding text (the validity line sits right next to the code), not
    // just handle a clean copy of the digits alone.
    await requestCode(page, MAYA.typed);
    const code = await codeFor(MAYA.e164);
    const wholeMessage = [
      'קוד הכניסה שלך לפורטל בעלי הדירות:',
      `*${code}*`,
      '',
      'הקוד תקף ל-5 דקות.',
      'אם לא ביקשת קוד — התעלם מההודעה ופנה לחברת הניהול.',
    ].join('\n');
    await codeField(page).evaluate((el, text) => {
      const dt = new DataTransfer();
      dt.setData('text', text);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, wholeMessage);
    await page.waitForURL('**/portal');
  });

  test('an OS-level autofill-style injection (no paste event, no clipboard) still fills the field and verifies', async ({ page }) => {
    // Simulates Android's own "use code" keyboard suggestion / iOS's
    // QuickType chip: the whole six-digit string lands via a native value
    // set + a plain `input` event — never a `paste` event, never six
    // separate keystrokes, and never touching the clipboard at all. Before
    // 17/10/2026 (six `maxLength={2}` boxes) this would have been truncated
    // to one or two digits in whichever box happened to be focused.
    await requestCode(page, ASAF.typed);
    const code = await codeFor(ASAF.e164);
    await codeField(page).evaluate((el: HTMLInputElement, c: string) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(el, c);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, code);
    await page.waitForURL('**/portal');
  });

  test('16: an unregistered number gets an INLINE message with the details — no window, field still live', async ({ page }) => {
    await page.goto('/portal/login');
    const field = page.getByLabel('מספר טלפון');
    const notice = page.getByRole('alert').filter({ hasText: 'אינו רשום באף דירה' });

    // Six taps: one more than PORTAL_OTP_MAX_REQUESTS_PER_WINDOW. Before
    // 29/09/2026 the sixth locked the number out for 30 minutes although no
    // code had ever been sent to it — which is what happened to apartment 1233.
    for (let i = 0; i < 6; i += 1) {
      await sendCode(page, NOT_AN_OWNER);
      await expect(notice).toBeVisible();
      await expect(notice).toContainText('050-999-9999');

      // Ronen's decision, 30/09/2026: NO window. A number that is almost
      // always a typo must not need a dismiss before it can be corrected.
      await expect(page.getByRole('dialog')).toHaveCount(0);
      // …and the field is still live, still holding what was typed.
      await expect(field).toBeEnabled();
      await expect(field).toHaveValue(NOT_AN_OWNER);
      await expect(field).toBeFocused();

      if (i === 0) {
        // The details are INSIDE the message and already open — no second
        // click. The tel: variant is in the DOM but display:none on this
        // viewport, so it is out of the accessibility tree: css, not role.
        await expect(notice.locator('a[href^="tel:"]')).toHaveAttribute('href', 'tel:+97248341881');
        await expect(notice.getByText('04-834-1881', { exact: true })).toBeVisible();
        await expect(notice.getByText('mgmt@example.test', { exact: true })).toBeVisible();
        // The address carries the join request's subject, with the number in it.
        await expect(notice.locator('a[href^="mailto:"]')).toHaveAttribute(
          'href',
          `mailto:mgmt@example.test?subject=${encodeURIComponent('בקשת הצטרפות לפורטל — 050-999-9999')}`,
        );
      }
    }

    // Correcting the number clears the message on the first keystroke.
    await field.fill('050999999');
    await expect(notice).toBeHidden();

    const locks = await pool.query(`select 1 from public.portal_lockouts where phone_e164 = $1`, ['+972509999999']);
    expect(locks.rowCount).toBe(0);
    // It stays on step 1 — no code step for a number that got no code.
    await expect(page.getByRole('heading', { name: 'כניסת בעלי דירות' })).toBeVisible();
  });
});

test.describe('the OTP states that decide whether someone gets in', () => {
  test('06 → 07: a wrong code shows the count, and a correction costs ONE attempt', async ({ page }) => {
    await requestCode(page, GALIT.typed);
    const code = await codeFor(GALIT.e164);
    const [wrong1, wrong2] = wrongCodes(code, 2) as [string, string];

    await typeCode(page, wrong1);
    // 06 — the server's own count, not a tally the screen kept.
    await expect(page.getByText('הקוד שגוי. נותרו 4 ניסיונות.')).toBeVisible();
    const after1 = await pool.query<{ attempts: number }>(
      `select attempts from public.portal_otp_codes where phone_e164 = $1 order by created_at desc limit 1`,
      [GALIT.e164]);
    expect(after1.rows[0]!.attempts).toBe(1);

    // 07 — the first touch clears the field and the line goes neutral.
    await codeField(page).click();
    await expect(page.getByRole('status')).toContainText('הזינו את הקוד מחדש');
    await expect(codeField(page)).toHaveValue('');

    // Retyping the whole code is ONE attempt — not one per keystroke.
    await typeCode(page, wrong2);
    await expect(page.getByText('הקוד שגוי. נותרו 3 ניסיונות.')).toBeVisible();
    const after2 = await pool.query<{ attempts: number }>(
      `select attempts from public.portal_otp_codes where phone_e164 = $1 order by created_at desc limit 1`,
      [GALIT.e164]);
    expect(after2.rows[0]!.attempts).toBe(2);

    // And the right code still works afterwards.
    await codeField(page).click();
    await typeCode(page, code);
    await page.waitForURL('**/portal');
  });

  test('08 → 12/14: the last attempt is announced, then the lock, with a countdown', async ({ page }) => {
    await requestCode(page, DAVID.typed);
    const code = await codeFor(DAVID.e164);
    const wrong = wrongCodes(code, 5);

    // Four wrong codes: the fourth leaves one attempt, which is the warning.
    for (let n = 1; n <= 4; n += 1) {
      await codeField(page).click();
      await typeCode(page, wrong[n - 1]!);
      if (n < 4) {
        await expect(page.getByText(`הקוד שגוי. נותרו ${5 - n} ניסיונות.`)).toBeVisible();
      }
    }
    // 08 — amber, before the last try, so the lock cannot surprise anyone.
    await expect(page.getByRole('status').filter({ hasText: 'ניסיון אחרון' }))
      .toContainText('ניסיון אחרון. קוד שגוי נוסף יחסום את הכניסה ל-30 דקות.');
    // Four attempts on the server — the screen and the database agree.
    const four = await pool.query<{ attempts: number }>(
      `select attempts from public.portal_otp_codes where phone_e164 = $1 order by created_at desc limit 1`,
      [DAVID.e164]);
    expect(four.rows[0]!.attempts).toBe(4);

    // The fifth locks: the sheet of state 14, and it does not close on the
    // backdrop.
    await codeField(page).click();
    await typeCode(page, wrong[4]!);
    const sheet = page.getByRole('dialog', { name: 'הכניסה נחסמה זמנית' });
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('אפשר לנסות שוב בעוד');
    await page.mouse.click(5, 5);
    await expect(sheet).toBeVisible();

    const lock = await pool.query<{ tier: number; reason: string }>(
      `select tier, reason from public.portal_lockouts where phone_e164 = $1`, [DAVID.e164]);
    expect(lock.rowCount).toBe(1);
    expect(lock.rows[0]).toMatchObject({ tier: 1, reason: 'too_many_invalid_codes' });

    // 12 — behind the sheet: the red card, its live countdown, and no login
    // button at all.
    await sheet.getByRole('button', { name: 'שינוי מספר' }).click();
    await expect(page.getByRole('heading', { name: 'כניסת בעלי דירות' })).toBeVisible();
  });

  test('11: an expired code locks the field and the action becomes "שלח קוד חדש"', async ({ page }) => {
    await requestCode(page, YOSSI.typed);
    const code = await codeFor(YOSSI.e164);
    // Age the live code past its TTL — and past the 45-second resend cooldown,
    // which is measured on created_at, so "שלח קוד חדש" is actually allowed.
    await pool.query(
      `update public.portal_otp_codes
          set expires_at = now() - interval '1 minute', created_at = now() - interval '6 minutes'
        where id = (select id from public.portal_otp_codes where phone_e164 = $1 order by created_at desc limit 1)`,
      [YOSSI.e164]);

    await typeCode(page, code);
    await expect(page.getByRole('status')).toContainText('תוקף הקוד פג. שלחו קוד חדש כדי להמשיך.');
    await expect(codeField(page)).toBeDisabled();
    await expect(page.getByRole('button', { name: 'שלח קוד חדש' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'כניסה לפורטל' })).toHaveCount(0);

    // 10 — a new code: the toast, empty boxes, and the previous code dead.
    await page.getByRole('button', { name: 'שלח קוד חדש' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'קוד חדש נשלח בוואטסאפ' })).toBeVisible();
    const fresh = await codeFor(YOSSI.e164);
    expect(fresh).not.toBe(code);
    await typeCode(page, code);          // the OLD code
    await expect(page.getByText(/^הקוד שגוי\./)).toBeVisible();
    await codeField(page).click();
    await typeCode(page, fresh);         // the new one
    await page.waitForURL('**/portal');
  });

  test('09: once the timer runs out the resend card appears — WhatsApp only, no redundant fallback button', async ({ page }) => {
    // The clock is faked before anything loads, so the screen's own interval is
    // the one being fast-forwarded — 45 real seconds is longer than the test
    // timeout and waiting for them would prove nothing extra.
    await page.clock.install();
    await requestCode(page, RUTI.typed);
    // The 45-second cooldown of the reference is what the screen counts down.
    await expect(page.getByText('שליחה חוזרת בעוד')).toBeVisible();
    await expect(page.getByText('לא קיבלת את הקוד?')).toHaveCount(0);

    // Skip the wait: the card is shown by the timer reaching zero.
    await page.clock.install();
    await page.clock.runFor('00:50');
    await expect(page.getByText('לא קיבלת את הקוד?')).toBeVisible();
    await expect(page.getByRole('button', { name: 'שלח שוב בוואטסאפ' })).toBeVisible();
    // 15/10/2026: no SMS provider is configured in this stack, so the server
    // keeps defaulting to WhatsApp (otpChannel.ts#resolveDefaultChannel) —
    // and "שלח בוואטסאפ במקום" must NOT appear next to it: it would offer
    // the one channel already in use.
    await expect(page.getByText('SMS')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'שלח בוואטסאפ במקום' })).toHaveCount(0);
  });
});
