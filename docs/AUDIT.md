# npm audit — 05/09/2026 (ענף `infra/hardening`)

ריצה: `npm audit --json` ו-`npm audit --omit=dev --json` על `package-lock.json` של `9c592f0`
(node 20.20.1, npm 10.8.2). **שום דבר לא שודרג** — מסמך ממצאים בלבד. ההחלטות (מה לשדרג ובאיזה
סדר) הן ב-HANDOFF 8; ההפעלה — דרך PR-ים של Renovate או ידנית, אחד-אחד, עם `check:all` + e2e.

## סיכום

| קבוצה | סה"כ | low | moderate | high | critical |
|---|---|---|---|---|---|
| הכל (`npm audit`) | **27** | 3 | 9 | 14 | 1 |
| production בלבד (`--omit=dev`) | **22** | 3 | 6 | 13 | 0 |
| dev בלבד (ההפרש — שרשרת `vitest`) | **5** | 0 | 3 | 1 | 1 |

- `REPORT.md` דיווח על 28 — מאגר ה-advisories השתנה בין הריצות (אותו lockfile). היום 27.
- **npm audit מפספס critical אחד ב-production**: ה-RCE ב-Image Optimization API של Next
  ([GHSA-2xp9-vwfh-vxw4](https://github.com/vercel/next.js/security/advisories/GHSA-2xp9-vwfh-vxw4),
  25/08/2026) עדיין לא נמצא במאגר של npm, אבל לפי ה-advisory של vercel הטווח הפגיע הוא **`<16.3.3`** —
  כלומר `next@16.2.9` שלנו כלול. התמונה האמיתית של production היא **1 critical + 13 high**.
- 4 תלויות production **ישירות** פגיעות: `next`, `nodemailer`, `exceljs`, `puppeteer-core` (פירוט למטה).
  18 טרנזיטיביות. ב-dev — רק שרשרת `vitest`.

## תלויות production ישירות

### 1. `next` 16.2.9 → **16.3.4** — שדרוג **minor**

| | |
|---|---|
| מותקן | 16.2.9 (09/2026: `latest` = 16.3.4) |
| advisories שמופיעים ב-audit | 9 ישירים, כולם בטווח `>=16.0.0 <16.2.11`: 4 high (Middleware/Proxy bypass ב-Turbopack, DoS ב-Server Actions, SSRF ב-Server Actions על custom server, SSRF ב-rewrites) + 5 moderate (cache confusion ×2, payload לא חסום ב-Edge, DoS ב-Image Optimization דרך SVG, חשיפת endpoints של Server Functions). בנוסף דרך תלויות ש-Next נועל: `postcss` (4 advisories, קריאת קבצים דרך `sourceMappingURL`) ו-`sharp <0.35.0` (high, CVE-ים של libvips). |
| **לא** ב-audit (מ-GitHub) | **critical** — RCE לא מאומת ב-Image Optimization API עם קבצי AVIF, טווח `<16.3.3`. וגם critical שני (RCE בשרתי Windows, `>=16.0 <16.3.3`) — **לא רלוונטי** (Linux). |
| גרסה מתוקנת | **16.3.4**. 16.2.11 סוגר רק את 9 הישירים; אין 16.2.13 — ה-RCE של AVIF ותיקוני `sharp`/`postcss` קיימים רק ב-16.3.3+. 16.3.4 = 16.3.3 + החזרת AVIF ל-Image Optimization + 3 backports. |
| סוג | **minor** (16.2 → 16.3), אותו major. `fixAvailable` של npm: `isSemVerMajor=false`. |
| חשיפה שלנו | `/_next/image` קיים כברירת-מחדל גם בלי שימוש ב-`next/image` (0 קבצים אצלנו) ובלי `images.remotePatterns` — זה מצמצם את משטח התקיפה (אין URL-ים מרוחקים) אבל לא מבטל אותו. התיקון הוא השדרוג. |

**Breaking changes שנוגעים לקוד שלנו — אין פורמליים (minor).** נבדק מול release notes של 16.3.0–16.3.4:

- "Deprecate edge runtime" — אצלנו רק `export const runtime = 'nodejs'` (5 קבצים). לא נוגע.
- אזהרת deprecation על `middleware.ts` (+ codemod ל-`proxy.ts`) — יש לנו `src/middleware.ts`. ממשיך לעבוד
  ב-16.x, אזהרה בלבד. הסבה = שינוי שם הקובץ ו-`export function proxy`. לא חוסם.
- ניקוי אופציות TypeScript מיושנות (`baseUrl`, `moduleResolution: node`) — `tsconfig.json` שלנו כבר על
  `moduleResolution: bundler` בלי `baseUrl`; TypeScript 5.9.3. לא נוגע.
- דגלים שהוסרו (`partialFallbacks`, guard של `unstable_io`, prefetch ב-instant config) — לא בשימוש.
- Turbopack עבר לקידוד hash אחר (base38) → שמות chunks משתנים → כרגיל, פריסה **רק** דרך `npm run deploy`.
- תאימות: `engines.node >=20.9.0` ✓ (20.20.1) · peer `react ^19` ✓ (19.2.4 נעוץ) · `@sentry/nextjs@10.73.0`
  peer `^16.0.0-0` ✓ · `@playwright/test ^1.51.1` ✓ (1.63.0).
- לשדרג **יחד**: `eslint-config-next` 16.2.9 → 16.3.4 (dev).
- אימות: `check:all` + `test:e2e` + smoke בפרודקשן (`/api/health`, login, PDF של דייר).

### 2. `nodemailer` 8.0.11 → **9.0.1 מינימום / 9.1.1 מומלץ / 10.0.0 latest** — שדרוג **major**

| | |
|---|---|
| מותקן | 8.0.11 (הגרסה האחרונה של 8.x — אין 8.0.12) |
| advisory | [GHSA-p6gq-j5cr-w38f](https://github.com/advisories/GHSA-p6gq-j5cr-w38f) (CVE-2026-82659, **high**): אופציית `raw` ברמת ההודעה עוקפת `disableFileAccess`/`disableUrlAccess` → קריאת קבצים / SSRF לתוך ההודעה הנשלחת. טווח `<=9.0.0`, תוקן ב-**9.0.1**. |
| גרסה מתוקנת | 9.0.1 היא המינימום. **9.1.1** (01/09/2026) = סוף סדרת 9 עם הקשחות נוספות (STARTTLS 9.0.3, header injection 9.0.5, addressparser בזמן לינארי 9.1.0). `fixAvailable` של npm מצביע על **10.0.0** (03/09/2026 — בת יומיים). |
| סוג | **major** בכל מקרה (8→9 או 8→10). |
| חשיפה שלנו | לא ניתנת לניצול בשימוש הנוכחי: `sendMail` מקבל `from/to/subject/html/text` שאנחנו בונים; אין `raw`, אין attachments עם `path`/`href`, אין OAuth2, אין proxy (נבדק ב-`src/lib/email/*`). התיקון עדיין זול. |

**Breaking changes:**

- **9.0.0** — אימות תעודת TLS כברירת-מחדל **בעת הבאת תוכן מרוחק** (attachments עם URL, endpoint של OAuth2,
  HTTP proxy CONNECT). אנחנו לא עושים אף אחד מהם → **לא נוגע**. חיבור ה-SMTP עצמו (`smtp.gmail.com:587`,
  `secure:false` + `requireTLS`) לא השתנה — שם אימות התעודה היה ברירת-מחדל גם קודם. ה-e2e מול Mailpit
  (`SMTP_REQUIRE_TLS=false`) לא מושפע.
- **10.0.0** — (א) Node ≥ 20 — שרת 20.20.1 ✓, CI node 20 ✓. (ב) שכתוב ל-TypeScript עם build כפול ESM+CJS
  **ומגיע עם טיפוסים משלו** (`types: ./dist/cjs/nodemailer.d.ts`) → להסיר את `@types/nodemailer@8.0.0`
  (אחרת הכפלת הצהרות). ה-changelog מציין במפורש "keep the @types/nodemailer type layout working" ו-"keep a
  transporter assignable to the plain Transporter type" → ה-`import nodemailer, { type Transporter }` שלנו
  אמור להישאר. (ג) ה-API שאנחנו משתמשים בו — `createTransport` עם pool (`pool/maxConnections/maxMessages/
  connectionTimeout/greetingTimeout/socketTimeout`), `sendMail`, `transporter.on('error')`, `close()`,
  `info.messageId`, שגיאות `code === 'EAUTH'` ו-`responseCode` 534/535 — לא מוזכר כשינוי.
- המלצה: **9.1.1** כצעד נמוך-סיכון (אותו package CJS, אותם `@types`), 10.0.0 כשיתייצב. אימות:
  `tests/smtp-auth-alert.test.ts`, `tests/legal-status-email.test.ts` + e2e "שליחת מייל בדיקה" (Mailpit).

### 3. `exceljs` 4.4.0 → **אין גרסה מתוקנת**

| | |
|---|---|
| מותקן | 4.4.0 = `latest` (12/2024). קיימת רק `4.4.1-prerelease.0` — גם היא `uuid@^8.3.0`. |
| advisory | דרך `uuid@8.3.2` (exceljs נועל `^8.3.0`): [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) (CVE-2026-41907, **moderate**): חסר bounds check ב-`v3/v5/v6` כשמעבירים `buf`. תוקן ב-uuid 11.1.1 / 12.0.1 / 13.0.1 (latest 14.0.2). |
| "התיקון" של npm | `exceljs@3.4.0`, `isSemVerMajor=true` — **downgrade** לגרסה שלפני uuid. לא אופציה. |
| סוג | אין שדרוג של exceljs שסוגר את זה. |
| חשיפה שלנו | לא ניתנת לניצול: exceljs קורא רק ל-`uuidv4()` (אקראי, בלי `buf`) — `lib/xlsx/xform/sheet/cf-ext/cf-rule-ext-xform.js`, מזהי conditional-formatting בכתיבה. הנתיב הפגיע (`v3/v5/v6` + `buf`) לא נקרא, ותוכן ה-xlsx שהמשתמש מעלה לא מגיע ל-uuid. |

**אופציות (לא בוצעו):** `overrides` ב-`package.json` — `{"exceljs": {"uuid": "^11.1.1"}}`. uuid 11 עדיין מייצא CJS
(`exports['.'].node.require = ./dist/cjs/index.js`) עם `v4` → ה-`require('uuid')` של exceljs ימשיך לעבוד;
זה משתיק את audit בלי לשנות התנהגות. אלטרנטיבה גדולה: החלפת exceljs (לא מוצדק בגלל moderate לא-נגיש).

### 4. `puppeteer-core` 24.43.1 → **25.10.0** — שדרוג **major**

| | |
|---|---|
| מותקן | 24.43.1 → `@puppeteer/browsers@2.13.2` → `extract-zip@2.0.1` |
| advisory | [GHSA-jmr9-qjv8-65gv](https://github.com/advisories/GHSA-jmr9-qjv8-65gv) (CVE-2026-56876, **high**): path traversal דרך symlink בחילוץ zip. `extract-zip` **בלי גרסה מתוקנת** (2.0.1 = latest). |
| גרסה מתוקנת | `@puppeteer/browsers@3.0.0` (12/05/2026) החליף את extract-zip ב-`tar`/`unzip` של מערכת ההפעלה → דורש **`puppeteer-core@25.0.0+`**; latest **25.10.0**. |
| "התיקון" של npm | `puppeteer-core@19.8.3` (לפני שנולד `@puppeteer/browsers`) — **downgrade** של 5 majors. לא אופציה. |
| סוג | **major** (24 → 25). |
| חשיפה שלנו | לא ניתנת לניצול בפרודקשן: extract-zip רץ רק בהורדת דפדפן (`@puppeteer/browsers install`). אנחנו מפעילים Chrome של המערכת (`executablePath: CHROME_PATH` → Google Chrome 146 בשרת) ולא מורידים כלום. |

**Breaking changes ב-25.0.0 שנוגעים לנו — יש, ואחד מהם חוסם:**

- **Node ≥ 22.12.0** (`engines`) — השרת מריץ **Node 20.20.1** (`/usr/bin/node`, `billing.service`) וה-CI
  `setup-node@20`. **תנאי מקדים**: שדרוג Node בשרת + ב-CI (Next 16 תומך ב-22 ✓). בלי זה `npm ci` יזהיר
  וה-runtime עלול לשבור.
- **ESM בלבד** (`"type": "module"`) — `src/app/api/debtors/[id]/pdf/route.ts` עושה `import puppeteer from
  'puppeteer-core'` ו-`next.config.ts` שומר אותו חיצוני (`serverExternalPackages`) → השרת ה-standalone
  טוען אותו בזמן ריצה מ-`node_modules`. ב-Node 22.12 `require(esm)` פתוח, אבל **חייב אימות אמיתי**:
  build + `GET /api/debtors/<id>/pdf`.
- `page.setCookie()` — עדיין קיים ב-25.10.0 אך **`@deprecated`** (→ `browser.setCookie()` /
  `browserContext.setCookie()`). מתקמפל, אזהרה בלבד; כדאי להסב באותו PR.
- **לא** בשימוש אצלנו: `Puppeteer.product`, `Browser.isConnected()`, `MouseOptions.clickCount`, מאפיין
  cookie `sameParty`, `executablePath()`/`defaultArgs()` כפונקציות (אנחנו מעבירים את האופציה), נרמול headers.
- `page.pdf()` מחזיר `Uint8Array` (כבר מ-v22) — מטופל (`Buffer.from(pdf)`).
- אחרי השדרוג לאמת רינדור PDF מול Chrome 146 של המערכת (CDP סובלני לפערי גרסה, אבל זה הנתיב היחיד
  שמשתמש בחבילה).

## תלויות production טרנזיטיביות (18)

`npm audit fix` (**בלי** `--force`) פותר את 13 הראשונות בתוך טווחי ה-semver הקיימים; 5 האחרונות נעולות
לתלות ישירה ונפתרות רק איתה.

| חבילה | חומרה | מי מושך אותה | נטען ב-runtime? | תיקון |
|---|---|---|---|---|
| `@babel/core` | low | `@sentry/nextjs`, `eslint-config-next`, `shadcn` | לא (build/lint) | `audit fix` |
| `@hono/node-server` | moderate | `shadcn` (CLI) | לא | `audit fix` |
| `body-parser` | low | `shadcn` | לא | `audit fix` |
| `brace-expansion` | high | `eslint`, `typescript-eslint`, `eslint-config-next`, `exceljs`→`archiver`→`readdir-glob` | חלקית (exceljs); ה-DoS דורש תבנית glob מהמשתמש — אין | `audit fix` |
| `browserslist` | high | `@sentry/nextjs`, `shadcn` | לא (build) | `audit fix` |
| `dompurify` | moderate | `jspdf` | כן (ייצוא PDF); אנחנו לא קוראים ל-DOMPurify ישירות | `audit fix` |
| `express-rate-limit` | moderate | `shadcn` (דרך `ip-address`) | לא | `audit fix` |
| `fast-uri` | high | `shadcn` | לא | `audit fix` |
| `hono` | high (21 advisories) | `shadcn` | לא | `audit fix` |
| `ip-address` | high | `puppeteer-core` (proxy — לא בשימוש), `shadcn` | לא בפועל | `audit fix` |
| `nanoid` | high | `next`, `@tailwindcss/postcss` | כן (Next פנימי, גדלים קבועים — לא בשליטת תוקף) | `audit fix` |
| `postcss-selector-parser` | low | `shadcn` | לא | `audit fix` |
| `qs` | moderate | `shadcn` | לא | `audit fix` |
| `postcss` | high | `next` (עותק נעול), `@tailwindcss/postcss`, `shadcn`, `vitest` | build בלבד; ה-CSS שלנו | **`next@16.3.4`** (+ `audit fix` לעותק העליון) |
| `sharp` | high | `next` | כן (`/_next/image`) | **`next@16.3.4`** |
| `uuid` | moderate | `exceljs` | כן (v4 בלבד) | אין — ראה exceljs |
| `extract-zip` | high | `puppeteer-core`→`@puppeteer/browsers` | לא (הורדת דפדפן בלבד) | **`puppeteer-core@25`** |
| `@puppeteer/browsers` | high | `puppeteer-core` | לא | **`puppeteer-core@25`** |

**תצפית:** `shadcn@4.4.0` (ה-CLI של `npx shadcn add`) יושב ב-`dependencies` ומושך 8 מ-18 הממצאים
הטרנזיטיביים (`hono`, `@hono/node-server`, `express-rate-limit`, `ip-address`, `body-parser`, `qs`,
`fast-uri`, `postcss-selector-parser`). הוא לא מיובא בשום מקום בזמן ריצה. העברה ל-`devDependencies` (או
הסרה) מנקה אותם ממשטח ה-production של audit. לא בוצע.

## dev בלבד (5) — שרשרת `vitest`

| חבילה | מותקן | חומרה | advisory | חשיפה שלנו |
|---|---|---|---|---|
| `vitest` | 2.1.9 | **critical** | [GHSA-5xrq-8626-4rwp](https://github.com/advisories/GHSA-5xrq-8626-4rwp) (CVE-2026-47429): קריאה/הרצה של קבצים כששרת ה-**Vitest UI** מאזין (`vitest --ui`). טווח `<3.2.6`. | אין — מריצים `vitest run` בלבד (pre-push, CI), בלי UI ובלי watch. |
| `vite` | 5.4.21 | high | path traversal ב-`.map` של optimized deps; `launch-editor` NTLM (Windows); `server.fs.deny` bypass (Windows). | אין — אין dev server של vite (Next רץ על Turbopack); vite הוא רק שכבת ה-transform של vitest. |
| `vite-node` | 2.1.9 | moderate | דרך `vite`. | אין. |
| `@vitest/mocker` | 2.1.9 | moderate | דרך `vite`. | אין. |
| `esbuild` | 0.27.7 / ≤0.24.2 (עותק של vite) | moderate | dev server מקבל בקשות מכל אתר (`<=0.24.2`); קריאת קבצים ב-Windows. | אין. |

- תיקון: **`vitest@4.1.11`** לפי npm (major 2→4; `5.0.0` מ-03/09/2026 גם אפשרי). `3.2.7` סוגר רק את
  ה-advisory של vitest עצמו ולא את שרשרת vite 5/6.
- `vitest.config.ts` שלנו מינימלי (alias `@`/`server-only`, `environment: node`, `include`) → ההסבה
  צפויה טריוויאלית; אימות = 29 קבצים / 360 בדיקות עוברות.

## מה לא נעשה, ובאיזה סדר הייתי מתקדם

לא שודרג כלום (כך הוגדרה המשימה). סדר מוצע, כל צעד = PR נפרד + `check:all` + e2e:

1. **`next@16.3.4` + `eslint-config-next@16.3.4`** — סוגר את ה-critical היחיד ב-production (+ `sharp`, `postcss`). minor.
2. **`nodemailer@9.1.1`** — סוגר high; major אבל בלי נגיעה בקוד שלנו.
3. **`npm audit fix`** (בלי `--force`) — 13 הטרנזיטיביות. לבדוק ש-`package-lock.json` בלבד השתנה.
4. **`vitest@4.x`** (dev) — סוגר את ה-critical של dev.
5. **`overrides` ל-`uuid@^11.1.1` תחת exceljs** — משתיק moderate לא-נגיש.
6. **`puppeteer-core@25`** — **רק אחרי** Node 22 בשרת וב-CI, עם אימות PDF.
7. **`shadcn` → devDependencies** — ניקיון משטח, לא אבטחה.

## איך לשחזר

```bash
npm audit                 # הכל (27)
npm audit --omit=dev      # production בלבד (22)
npm audit --json | node -e 'const a=JSON.parse(require("fs").readFileSync(0));for(const [k,v] of Object.entries(a.vulnerabilities))console.log(k,v.severity,v.isDirect?"direct":"transitive",JSON.stringify(v.fixAvailable))'
```
