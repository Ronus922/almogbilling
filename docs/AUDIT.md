# npm audit — 04/10/2026 (ענף `chore/deps-audit`)

## מדיניות חולשות npm (מ-04/10/2026, החלטת רונן)

1. **critical / high בקוד ריצה** (נכנס ל-build ולשרת) — מתקנים כשיש שדרוג **בלי שבירת תאימות**: patch/minor,
   או עדכון של תלות עקיפה בתוך הטווחים שהתלויות כבר מצהירות עליהם.
2. **אסור `npm audit fix --force`**, ואסור שדרוג major של `next`, `react` או ספרייה מרכזית אחרת במסגרת "תיקון חולשות".
3. **תיקון שמחייב שבירת תאימות** (major, downgrade, Node חדש) — לא נוגעים; מדווחים עם הערכת סיכון ונפתח PR נפרד בהחלטה.
4. **dev בלבד** — מתקנים רק אם טריוויאלי וללא שבירה; אחרת מדווחים.
5. **גם `npm audit fix` בלי `--force` לא עובר בלי בדיקה:** ב-04/10 הוא העלה את `shadcn` 4.4.0 → 4.21.1 (בתוך
   `^4.4.0`), ו-`shadcn/tailwind.css` — שמיובא ב-`globals.css` — הוסיף `@property` גלובליים וכלל `.shimmer` לא
   משוכב ל-CSS של האפליקציה, ועוד משך ממצא high חדש (`@shadcn/registry`). לכן התיקון נעשה ב-`npm update <חבילה>`
   ממוקד לכל חבילה פגיעה, וכל שינוי ב-`package-lock.json` נבדק מול הרשימה (אף major).

## סיכום — לפני / אחרי (04/10/2026)

| | critical | high | moderate | low | סה״כ |
|---|---|---|---|---|---|
| `npm audit` — לפני | 2 | 23 | 10 | 3 | **38** |
| `npm audit` — **אחרי** | 1 | 18 | 5 | 0 | **24** |
| `npm audit --omit=dev` — לפני | 1 | 19 | 7 | 3 | **30** |
| `npm audit --omit=dev` — **אחרי** | **0** | 14 | 2 | 0 | **16** |

`--omit=dev` לפי ההגדרה של npm כולל את `shadcn` (CLI שיושב ב-`dependencies`), ולכן אינו זהה ל"נטען בשרת".

## מה שודרג

| חבילה | לפני → אחרי | סוג | למה |
|---|---|---|---|
| `next` | 16.3.4 → **16.3.8** | patch (נעוץ, `--save-exact`) | **critical** — RCE ב-`next/og` `ImageResponse` ([GHSA-vcvr-r3jv-pc5j](https://github.com/advisories/GHSA-vcvr-r3jv-pc5j), `>=16.2.0 <16.3.6`). אצלנו אין `next/og`/`ImageResponse` — לא היה ניתן לניצול, אבל התיקון patch. |
| `eslint-config-next` (dev) | 16.3.4 → 16.3.8 | patch | נשאר צמוד ל-`next` (`@next/eslint-plugin-next` נגרר). |
| `ip-address` | 10.1.0 / 10.2.0 → 10.7.3 | minor (עקיפה) | high — SSRF/סיווג כתובות; דרך `puppeteer-core`→proxy (בשרת, לא בשימוש) ו-`shadcn`. |
| `brace-expansion` | 1.1.15–5.0.5 → 1.1.21 / 2.1.7 / 5.0.12 | patch (עקיפה, כל העותקים) | high — DoS; עותק אחד בשרת (`exceljs`→`archiver`→`readdir-glob`, `@sentry`→`glob`). |
| `dompurify` | 3.4.10 → 3.4.16 | patch (עקיפה) | moderate — דרך `jspdf` (לקוח). |
| `fast-uri`, `hono`, `@hono/node-server`, `qs`, `body-parser`, `express-rate-limit`, `postcss-selector-parser` | patch/minor | עקיפות | דרך ה-CLI של `shadcn` (`@modelcontextprotocol/sdk`) — לא נטענות בשרת. |
| `browserslist`, `baseline-browser-mapping`, `@babel/core` (+ משפחת `@babel/*`, `caniuse-lite`, `electron-to-chromium`, `node-releases`, `update-browserslist-db`) | patch/minor | עקיפות, build בלבד | high/moderate/low — כלי build. |

אין שינוי ב-`package.json` מלבד `next` ו-`eslint-config-next`. אף חבילה לא עברה major.

## מה נשאר — והערכת סיכון

| חבילה | חומרה | בשרת? | התיקון היחיד | למה לא עכשיו | סיכון בפועל |
|---|---|---|---|---|---|
| `nodemailer` 8.0.11 | high (8 advisories) | כן | **10.0.14** (major; 9.x כבר major) | שבירת תאימות — לפי המדיניות | **נמוך.** `sendMail({from,to,subject,html,text})` בלבד: אין `raw`, אין attachments, אין allow-list דומיינים, transport אחד. ה-DoS ב-addressparser דורש רשימת כתובות ענקית ב-`to` — הכתובות שלנו מגיעות מה-DB/ממסכי הצוות עם ולידציית zod, לא מקלט אנונימי. ראה סעיף 2 למטה. |
| `puppeteer-core` 24.43.1 + `@puppeteer/browsers`, `extract-zip`, `proxy-agent`, `pac-proxy-agent`, `get-uri`, `basic-ftp` | high ×7 | נטענות (ייצוא PDF) | `puppeteer-core@25` (major, **Node ≥ 22** — השרת וה-CI על 20) | שבירת תאימות + תנאי מקדים | **נמוך.** הנתיבים הפגיעים רצים רק בהורדת דפדפן ובפרוקסי להורדה; אנחנו מפעילים את Chrome של המערכת (`CHROME_PATH`) ולא מורידים כלום. `extract-zip` בלי גרסה מתוקנת בכלל. ראה סעיף 4. |
| `shadcn` 4.4.0 + `ts-morph`, `@ts-morph/common`, `fast-glob`, `micromatch`, `braces` | high ×6 | **לא** (CLI ל-`npx shadcn add`) | `shadcn@4.21` (מתקן את ts-morph בלבד, מוסיף `@shadcn/registry`) / אין גרסה מתוקנת ל-`braces` | משנה את ה-CSS של האפליקציה; לא מוריד את ספירת ה-high | **זניח** — רץ רק כשמפתח מריץ את ה-CLI. |
| `exceljs` 4.4.0 → `uuid` 8.3.2 | moderate ×2 | כן (ייצוא xlsx) | אין גרסת exceljs מתוקנת; `overrides` ל-uuid 11 = major בתלות עקיפה | שבירת תאימות | **אין** — exceljs קורא רק ל-`uuidv4()`; הנתיב הפגיע (`v3/v5/v6` עם `buf`) לא נקרא. |
| `vitest` 2.1.9 + `vite`, `vite-node`, `@vitest/mocker`, `esbuild` | **critical** + high + moderate ×3 | **לא** (dev) | `vitest@3.2.6+`/`4.1.11` (major) | dev, לא טריוויאלי | **אין** — ה-critical דורש שרת Vitest UI מאזין (`vitest --ui`); אנחנו מריצים `vitest run` בלבד (pre-push, CI). אין dev server של vite. |
| `eslint-config-next` / `@next/eslint-plugin-next` → `fast-glob` | high ×2 | לא (lint) | אין (npm מציע downgrade ל-14.2.35) | — | **זניח.** |
| `knip` 5.88.1 → `fast-glob` | high | לא (dev) | `knip@6` (major) | dev, לא טריוויאלי | **זניח.** |

## איך לשחזר

```bash
npm audit                          # 24
npm audit --omit=dev               # 16
npm audit --json | node -e 'const a=JSON.parse(require("fs").readFileSync(0));for(const [k,v] of Object.entries(a.vulnerabilities))console.log(k,v.severity,v.isDirect?"direct":"transitive",JSON.stringify(v.fixAvailable))'
```

---

# ריצה קודמת — 05/09/2026 (ענף `infra/hardening`)

> הפירוט למטה הוא ניתוח 05/09/2026. ההחלטות לגבי `nodemailer`, `exceljs`, `puppeteer-core` ושרשרת `vitest` עדיין
> תקפות (מספרי הגרסאות האחרונות התקדמו: `nodemailer` 10.0.14, `puppeteer-core` 25.12.0, `vitest` 5.0.3).
> צעד 3 ("`npm audit fix`") בוצע ב-04/10 בצורה ממוקדת (ראה המדיניות למעלה).

## מצב 05/09/2026

ריצה ראשונה: `npm audit --json` ו-`npm audit --omit=dev --json` על `package-lock.json` של `9c592f0`
(node 20.20.1, npm 10.8.2) — 27 / 22. **עודכן אחרי `f15ad65`** (`next@16.3.4` + `eslint-config-next@16.3.4`,
ריצה חוזרת על ה-lockfile החדש) — 23 / 18. מלבד next **שום דבר אחר לא שודרג**. ההחלטות (מה לשדרג ובאיזה
סדר) הן ב-`docs/archive/HANDOFF.md` סעיף 8; ההפעלה — דרך PR-ים של Renovate או ידנית, אחד-אחד, עם `check:all` + e2e.

## סיכום

| קבוצה | לפני `next@16.3.4` (lockfile `9c592f0`) | **עכשיו** (lockfile `f15ad65`) |
|---|---|---|
| הכל (`npm audit`) | 27 — 3 low, 9 moderate, 14 high, 1 critical | **23** — 3 low, 9 moderate, 10 high, 1 critical (dev: `vitest`) |
| production בלבד (`--omit=dev`) | 22 — 3 low, 6 moderate, 13 high, 0 critical (+ critical נסתר של `next`) | **18** — 3 low, 6 moderate, 9 high, **0 critical** |
| dev בלבד (ההפרש — שרשרת `vitest`) | 5 — 0 low, 3 moderate, 1 high, 1 critical | **5** — ללא שינוי |

- `REPORT.md` דיווח על 28 — מאגר ה-advisories השתנה בין הריצות (אותו lockfile). בריצה הראשונה 27.
- **ה-critical של production סגור.** ה-RCE ב-Image Optimization API של Next
  ([GHSA-2xp9-vwfh-vxw4](https://github.com/vercel/next.js/security/advisories/GHSA-2xp9-vwfh-vxw4),
  25/08/2026, טווח `<16.3.3`) לא מופיע במאגר של npm גם היום, אבל `next@16.3.4` מותקן מ-`f15ad65` — כך
  שה-"0 critical" ב-production נכון גם לפי GitHub, לא רק לפי npm. **שימו לב:** הפרודקשן (`/var/www/billing`)
  נשאר על 16.2.9 עד merge של הענף ו-`npm run deploy`.
- מה שנשאר ב-production: **3 תלויות ישירות** — `nodemailer` (high, שדרוג **major**), `puppeteer-core` (high,
  major, דורש Node 22), `exceljs` (moderate, אין גרסה מתוקנת) — ו-**15 טרנזיטיביות**, 12 מהן נסגרות ב-`npm audit fix`
  (פירוט למטה). ב-dev — רק שרשרת `vitest`.

## תלויות production ישירות

### 1. ~~`next` 16.2.9 → **16.3.4**~~ — **בוצע** (`f15ad65`, 05/09/2026, בענף הזה)

| | |
|---|---|
| מותקן | **16.3.4** (+ `eslint-config-next@16.3.4`; דרכו `sharp@0.35.4`). ריצת audit על ה-lockfile החדש: `next`, `postcss`, `sharp`, `nanoid` — לא מדווחים יותר. |
| אימות (05/09/2026) | `npm run build` ✓ · `check:all` ✓ (0 שגיאות lint; 4 אזהרות חדשות מהכלל החדש `@next/next/no-location-assign-relative-destination`, לא טופלו) · e2e 4/4 מקומית ✓ · CI ירוק (`check:all` + `e2e`) ✓. **עדיין לא:** smoke בפרודקשן — רק אחרי merge + `npm run deploy` (`/api/health`, login, PDF של דייר). |
| advisories שהופיעו ב-audit (לפני) | 9 ישירים, כולם בטווח `>=16.0.0 <16.2.11`: 4 high (Middleware/Proxy bypass ב-Turbopack, DoS ב-Server Actions, SSRF ב-Server Actions על custom server, SSRF ב-rewrites) + 5 moderate (cache confusion ×2, payload לא חסום ב-Edge, DoS ב-Image Optimization דרך SVG, חשיפת endpoints של Server Functions). בנוסף דרך תלויות ש-Next נועל: `postcss` (4 advisories, קריאת קבצים דרך `sourceMappingURL`) ו-`sharp <0.35.0` (high, CVE-ים של libvips). |
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
- שודרג **יחד**: `eslint-config-next` 16.2.9 → 16.3.4 (dev). בפועל אף אחד מהסעיפים למעלה לא דרש שינוי קוד.
- אימות: `check:all` + `test:e2e` — בוצע (ראה טבלה). smoke בפרודקשן (`/api/health`, login, PDF של דייר) — אחרי deploy.

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

## תלויות production טרנזיטיביות (15; היו 18)

נסגרו ב-`next@16.3.4`: `postcss` (העותק שנעל next), `sharp` (→ 0.35.4), `nanoid` (העותק הפגיע נמשך על-ידי next).
`npm audit fix` (**בלי** `--force`) פותר את 12 הראשונות בתוך טווחי ה-semver הקיימים; 3 האחרונות נעולות
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
| `postcss-selector-parser` | low | `shadcn` | לא | `audit fix` |
| `qs` | moderate | `shadcn` | לא | `audit fix` |
| `uuid` | moderate | `exceljs` | כן (v4 בלבד) | אין — ראה exceljs |
| `extract-zip` | high | `puppeteer-core`→`@puppeteer/browsers` | לא (הורדת דפדפן בלבד) | **`puppeteer-core@25`** |
| `@puppeteer/browsers` | high | `puppeteer-core` | לא | **`puppeteer-core@25`** |

**תצפית:** `shadcn@4.4.0` (ה-CLI של `npx shadcn add`) יושב ב-`dependencies` ומושך 8 מ-15 הממצאים
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

## מה נעשה, מה לא, ובאיזה סדר להתקדם

צעד 1 בוצע בענף הזה; השאר לא (כך הוגדרה המשימה). סדר, כל צעד = PR נפרד + `check:all` + e2e:

1. ~~**`next@16.3.4` + `eslint-config-next@16.3.4`**~~ — **בוצע** (`f15ad65`). סגר את ה-critical היחיד ב-production (+ `sharp`, `postcss`, `nanoid`).
2. **`nodemailer@9.1.1`** — סוגר high; major אבל בלי נגיעה בקוד שלנו.
3. **`npm audit fix`** (בלי `--force`) — 13 הטרנזיטיביות. לבדוק ש-`package-lock.json` בלבד השתנה.
4. **`vitest@4.x`** (dev) — סוגר את ה-critical של dev.
5. **`overrides` ל-`uuid@^11.1.1` תחת exceljs** — משתיק moderate לא-נגיש.
6. **`puppeteer-core@25`** — **רק אחרי** Node 22 בשרת וב-CI, עם אימות PDF.
7. **`shadcn` → devDependencies** — ניקיון משטח, לא אבטחה.

## איך לשחזר

```bash
npm audit                 # הכל (23; היו 27 לפני next@16.3.4)
npm audit --omit=dev      # production בלבד (18; היו 22)
npm audit --json | node -e 'const a=JSON.parse(require("fs").readFileSync(0));for(const [k,v] of Object.entries(a.vulnerabilities))console.log(k,v.severity,v.isDirect?"direct":"transitive",JSON.stringify(v.fixAvailable))'
```
