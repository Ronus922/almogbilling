# Git Push Skill — ALMOG CRM

> Skill ידני לדחיפה ל-`origin/main`. מופעל **רק** כשהמשתמש מבקש
> במפורש: "תדחוף", "push", "commit ודחוף", "תעלה לגיט", וכו'.

## עקרונות אל-נגיעה

1. **רק קבצים ששונו** — לא `git add -A`, לא `git add .`, לא
   `git add -u`. רק קבצים ספציפיים שהוסכמו עם המשתמש.
2. **הודעות commit מנוסחות לפי תוכן ה-diff** — קודם קרא את
   ה-diffs, אחר כך נסח כותרת + body. לא "update X" סתמי.
3. **`pull --rebase` לפני `push`** — אם rebase יוצא נקי, ממשיך.
   אם יש קונפליקט אמיתי — עוצר ושואל.
4. **`PROJECT_CONTEXT.md` הוא מקור אמת** — אם המשתמש מציין
   החלטה חדשה, להוסיף ל-Decisions Log לפני ה-commit.
5. **אסור `--force` / `--no-verify` / `reset --hard` / `clean -fd`**
   ללא אישור מפורש של המשתמש.

---

## Workflow (סדר נוקשה)

### שלב 1 — אינוונטר מלא
```bash
git status --short
git diff --stat
git branch --show-current
```
הצג למשתמש:
- אילו קבצים שונו (M)
- אילו קבצים חדשים (??)
- אם יש staged כבר (A/M מצד שמאל)
- ענף נוכחי

### שלב 2 — בדיקת בטיחות
ודא שקבצים אלו **לא** מופיעים ב-`git status` כ-untracked:
- `.env`, `.env.local`, `.env.*`, `*.env`
- `node_modules/`
- `.next/`, `dist/`, `build/`, `.vercel/`
- `*.pem`, `*.key`, `*.tsbuildinfo`
- כל קובץ ששמו מכיל `secret`, `password`, `key`, `token`, `credentials`

אם אחד מהם מופיע — **עצור**. דווח למשתמש שה-`.gitignore`
חסר, בצע תיקון לפני שממשיכים.

בנוסף: סרוק קבצים חשודים (scripts, migrations, seed files,
config files) ל-hardcoded secrets / passwords / API keys
לפני commit.

### שלב 3 — קריאת diffs
לכל קובץ ששונה: `git diff <file>`.
לכל קובץ חדש: `Read <file>` (לפחות מבט-על).

מטרה: להבין מה השתנה, לא רק מה השמות.

### שלב 4 — קיבוץ לוגי
אם השינויים מתפרסים על מספר תחומים שאינם קשורים:
- **בצע פיצול לכמה commits** (לדוגמה: docs נפרד מ-feature)
- אם הכל קשור לאותו context — commit אחד

מתי לפצל בפועל:
- `docs:` נפרד מ-`feat:` / `fix:`
- כל slice = commit נפרד
- שינוי גדול ב-`DESIGN.md` נפרד מקוד שמיישם אותו

### שלב 5 — ניסוח הודעות
פורמט: `<type>(<scope>): <subject>`

Types בשימוש:
- `feat` — פיצ'ר חדש
- `fix` — תיקון באג
- `docs` — תיעוד בלבד
- `chore` — תחזוקה (gitignore, deps, config)
- `refactor` — שינוי קוד ללא שינוי התנהגות
- `style` — formatting, ללא שינוי קוד

Scope אופציונלי: `auth`, `dashboard`, `import`, `sidebar`,
`header`, `db`, `design`, וכו'.

Subject:
- imperative mood (`add` ולא `added`)
- בלי נקודה
- אנגלית קצרה
- מתחת ל-72 תווים

Body (אופציונלי, אך מומלץ לשינויים גדולים):
- מה השתנה ולמה
- decision rationale (אם יש)
- breaking changes (אם יש)
- רשימת קבצים מרכזיים (אם הרבה קבצים)

**הצג את כל ההודעות שניסחת למשתמש לפני שאתה רץ
`git commit`.** חכה לאישור.

### שלב 6 — Staging סלקטיבי
לכל commit:
```bash
git add <file1> <file2> <file3>
```
**אסור**: `git add -A`, `git add .`, `git add -u`.

הצג `git status` שוב כדי שהמשתמש יראה מה staged ומה לא.

### שלב 7 — Commit
```bash
git commit -m "<subject>"
```
או עם body (HEREDOC):
```bash
git commit -m "$(cat <<'EOF'
<subject>

<body line 1>
<body line 2>
EOF
)"
```

### שלב 8 — Sync עם origin
```bash
git pull --rebase origin main
```

**אם rebase יוצא נקי** (no conflicts) — המשך לשלב 9.

**אם יש conflicts**:
1. הרץ `git status` כדי לראות אילו קבצים בקונפליקט
2. **עצור** — אל תפתור אוטומטית
3. הצג למשתמש:
   ```
   קונפליקטים ב:
   - src/foo.ts
   - src/bar.ts

   רוצה שאעבור על הקונפליקטים ואציע פתרון, או
   `git rebase --abort` להשתמש בגישה אחרת?
   ```
4. חכה להחלטה.

### שלב 9 — Push
```bash
git push origin main
```
הצג את הפלט. אם הצליח, הרץ:
```bash
git log --oneline -5
```
כדי להראות שה-commits עלו.

### שלב 10 — Decisions Log (אם רלוונטי)
אם הדחיפה כללה החלטה ארכיטקטונית או הסכמה חדשה, שאל
את המשתמש:
"רוצה שאוסיף שורה ל-Decisions Log ב-PROJECT_CONTEXT.md?"
אם כן — עדכן ובצע commit נפרד (`docs: log <decision>`).

---

## Safety Rails — אסור בהחלט

- **לעולם לא** `git push --force` / `-f` ללא אישור מפורש
  של המשתמש (אישור אחד ≠ אישור עתידי).
- **לעולם לא** `git reset --hard` ללא אישור מפורש.
- **לעולם לא** `git clean -fd` ללא אישור מפורש.
- **לעולם לא** `--no-verify` (לעקיפת hooks) ללא אישור.
- אם `git status` לא נקי (ענפים אחרים שהוקמו בחיפוי) —
  עצור ושאל את המשתמש לפני שמתחילים.
- אם הענף לא `main` — שאל לפני push.

---

## דוגמאות

### דוגמה 1 — פיצול ברור
**משתמש:** "תדחוף את מה שיש"

**Skill:**
1. `git status --short` → 3 קבצים ב-`src/auth/`, קובץ
   `DESIGN.md` חדש
2. קורא diffs + מבין שזה 2 דברים נפרדים
3. מציע 2 commits:
   ```
   1. docs: add master design system document
      - DESIGN.md (new)

   2. fix(auth): resolve session expiry edge case on rebase
      - src/auth/session.ts
      - src/auth/middleware.ts
      - src/auth/types.ts
   ```
4. משתמש מאשר → stage + commit לכל אחד
5. `git pull --rebase origin main` → clean
6. `git push origin main` → success

### דוגמה 2 — ספק פיצול
**משתמש:** "תדחוף את השינויים שעשינו"

**Skill:** "ראיתי 5 קבצים ששונו, אבל רק 2 קשורים ל-login
(`src/auth/login-form.tsx`, `src/app/login/page.tsx`).
השאר הם `src/dashboard/KpiCard.tsx`, `DESIGN.md`,
`PROJECT_CONTEXT.md`. רוצה:
- א. רק את שני קבצי ה-login (השאר נשאר uncommitted)
- ב. הכל ב-3 commits לוגיים
- ג. הכל ב-commit אחד

מה עדיף?"

### דוגמה 3 — קונפליקט
**משתמש:** "push"

**Skill:**
1. אינוונטר → 1 קובץ שונה: `src/lib/db.ts`
2. commit מאושר ומבוצע
3. `git pull --rebase origin main` → conflict ב-`src/lib/db.ts`
4. עצירה ודיווח:
   ```
   יש קונפליקט ב-src/lib/db.ts. משהו אחר (כנראה מישהו
   שעבד על אותה מערכת) דחף עדכון לאותו קובץ ל-origin.

   רוצה:
   א. שאני אקרא את שתי הגרסאות ואציע פתרון
   ב. `git rebase --abort` ותחליט אחרת
   ```

---

## הערות נוספות

- **Postbuild Gotcha** (PROJECT_CONTEXT.md TODO): `npm run build`
  דורס את `.next/standalone/` בלי לעשות `systemctl restart`.
  אם הדחיפה כוללת שינוי קוד שמשפיע על runtime, הזכר למשתמש
  לעשות deploy אחרי merge.
- **שגיאות נפוצות**:
  - `non-fast-forward` → `git pull --rebase` ראשון
  - `permission denied` → בדוק SSH key / credentials
  - `pre-commit hook failed` → דווח, אל תעקוף עם `--no-verify`
- **Cross-project boundary**: לפי PROJECT_CONTEXT.md, הקוד של
  פרויקט `proj_billing` בלבד. אל תוסיף לcommit קבצים מ-
  `/var/www/almog/`, `/var/www/invoice/`, וכו'.
