# מיגרציות — dbmate

מ-05/09/2026 כל שינוי סכימה עובר דרך **dbmate** בלבד. `supabase/migrations/` (79
קבצי up + 8 קבצי `.down.sql`) הוא היסטוריה קפואה — לא נוגעים בו.

| מה | איפה |
|---|---|
| מיגרציות (dbmate) | `db/migrations/YYYYMMDDHHMMSS_name.sql` עם `-- migrate:up` / `-- migrate:down` |
| 79 הישנות | עטופות כ-`db/migrations/20000101000001_001_auth_tables.sql` … `20000101000079_078_legal_contact_setting.sql`, נוצרות מהמקור ע"י `scripts/db/gen-legacy-dbmate-migrations.mjs` (`npm run db:wrappers` מוודא שהן מסונכרנות) |
| סכימה | `db/schema.sql` — `npm run db:dump` (`scripts/db/dump-schema.sh`, דטרמיניסטי: מסנן שורות שתלויות בגרסת pg_dump) |
| סימון ההיסטוריה כ-applied | `scripts/db/mark-applied.sql` — **הורץ בפרודקשן ב-11/09/2026** (ראה למטה) |

## עבודה יומיומית

```bash
npm run db:new add_foo_column     # יוצר db/migrations/<timestamp>_add_foo_column.sql
# כותבים SQL תחת -- migrate:up ואת ההיפוך תחת -- migrate:down
npm run db:up                     # מריץ pending מול DATABASE_URL מ-.env.local
# בפרודקשן (השרת ללא SSL, ודרך החיבור הישיר ולא ה-pooler):
#   DATABASE_URL="<DIRECT_URL>?sslmode=disable" npm run db:up
npm run db:status                 # Applied / Pending
npm run db:rollback               # מבטל את האחרונה (migrate:down)
npm run db:dump                   # מעדכן db/schema.sql — לקומיט יחד עם המיגרציה
```

- כל מיגרציה רצה בטרנזקציה. אם צריך `create index concurrently` — כתוב
  `-- migrate:up transaction:false`.
- `dbmate` (lib/pq) דורש `?sslmode=disable` ב-URL כשהשרת ללא SSL (מקומי, CI).
- CI (`.github/workflows/ci.yml`): `dbmate up` על DB ריק (כל `db/migrations`), `dbmate status`,
  ובדיקת **parity** — הקבצים המקוריים דרך psql מול **העטיפות הישנות בלבד** (`20000101…`)
  דרך dbmate חייבים להפיק סכימה זהה. מיגרציות חדשות (`2026…`) אינן חלק מה-parity —
  אין להן מקבילה ב-`supabase/migrations` הקפוא.

## הפעלה בפרודקשן (פעם אחת) — בוצע ב-11/09/2026

**סטטוס:** בוצע. ב-11/09/2026 ה-diff מול הפרודקשן הכיל פונקציה יתומה אחת
(`public.handle_new_user()` — שריד Supabase-auth בלי טריגר ובלי טבלת `profiles`;
ההגדרה נשמרה ב-`/var/backups/billing/handle_new_user-20260911.sql`). היא נמחקה,
ה-diff יצא ריק, `mark-applied.sql` הורץ, ומאז `public.schema_migrations` קיימת
ב-`proj_billing` ו-`npm run db:up` (עם `DIRECT_URL` + `?sslmode=disable`) הוא
הדרך היחידה להחיל מיגרציה. הנוהל המקורי נשמר כאן לתיעוד:

הטבלה `public.schema_migrations` לא הייתה קיימת ב-`proj_billing`. לפני שמסמנים
את ההיסטוריה כ-applied חייבים להוכיח שהסכימה בפרודקשן זהה ל-`db/schema.sql`:

```bash
cd /var/www/billing && git pull
# 1. dump של הפרודקשן באותם דגלים ואותה גרסת pg_dump (15.8 בתוך supabase-db)
PG_CONTAINER=supabase-db PG_DB=proj_billing DATABASE_URL=postgresql://x@x/proj_billing \
  bash scripts/db/dump-schema.sh /tmp/prod-schema.sql
# 2. diff — עדיין בלי schema_migrations בפרודקשן, לכן משווים בלי הטריילר של dbmate
diff <(sed '/^-- Dbmate schema migrations/,$d' db/schema.sql) /tmp/prod-schema.sql
```

- **diff ריק** → מסמנים:
  ```bash
  docker exec -i supabase-db psql -U postgres -d proj_billing -v ON_ERROR_STOP=1 < scripts/db/mark-applied.sql
  DATABASE_URL="<DIRECT_URL של הפרודקשן>" npx dbmate --migrations-dir db/migrations --no-dump-schema status   # Applied: 79, Pending: 0
  ```
- **diff לא ריק** → לא מריצים כלום. שומרים את ה-diff ומחזירים אותו לבדיקה: הוא
  אומר שבפרודקשן יש שינוי ידני שלא עבר במיגרציה (או להפך).
