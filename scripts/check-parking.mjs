#!/usr/bin/env node
// INVARIANT: the parking data of lot 1P stays consistent with itself, with the
//   contacts registry, and with the 2015 source document "הצמדת חניות לדירות".
//
//   Two classes of check, treated differently on purpose:
//
//   A. STRUCTURAL — things that are simply wrong if they happen: a spot
//      pointing at an apartment that does not exist, a duplicate number, an
//      apartment link that disagrees with owner_type, capacity that does not
//      match size_type. These FAIL the script.
//
//   B. DOCUMENT COMPARISON — the six ownership buckets against the figures the
//      2015 document states. There is a KNOWN, ACCEPTED gap here: the source
//      encoded double spots as small digits in its notes column and those
//      digits did not survive OCR, so the data carries 9 doubles where the
//      document says 14. Failing on that would leave a permanently red check,
//      and a permanently red check is one everybody learns to ignore.
//
//      So the gap is PINNED instead: the script fails if the deviation stops
//      matching KNOWN_GAP below. Green today; red the moment the numbers move
//      for any reason — including someone "helpfully" inventing the five
//      missing doubles, which is exactly what must not happen silently.
//
//   Mirrors /api/parking/summary (see lib/db/parking.ts getParkingSummary) —
//   same buckets, same precedence, same expectations. Run: npm run check:parking
import { run, psql, fail, ok, info } from './_check-lib.mjs';

const LOT = '1P';

// Transcribed from the document. Kept here rather than imported from
// lib/constants/parking.ts on purpose: this script is an INDEPENDENT witness,
// and a check that reads its expectations from the same module the app uses
// would keep agreeing with the app even if that module were edited wrongly.
const EXPECTED = {
  developer_sold_apartments:   { label: 'חו״כ — הוצמדו לדירות שנמכרו',        spots: 108, doubles: 4, places: 112 },
  developer_unsold_apartments: { label: 'חו״כ — הוצמדו ל-7 דירות שטרם נמכרו', spots: 14,  doubles: 1, places: 15  },
  developer_retained:          { label: 'נותרו בבעלות חוף הכרמל',            spots: 35,  doubles: 9, places: 44  },
  committee_sold:              { label: 'נמכרו ע״י הנציגות',                 spots: 8,   doubles: 0, places: 8   },
  committee_in_process:        { label: 'בתהליך מכירה ע״י הנציגות',          spots: 4,   doubles: 0, places: 4   },
  committee_for_sale:          { label: 'נותרו לנציגות למכירה',              spots: 18,  doubles: 0, places: 18  },
};
const EXPECTED_TOTAL = { spots: 187, doubles: 14, places: 201 };

const UNSOLD = ['1341', '1407', '1440', '1539', '1619', '1620', '1628'];

// The accepted OCR gap, as signed deltas (actual - expected). Anything else fails.
//
// SOURCE OF THE GAP: the notes column of the 14.5.2015 document encoded double
// spots as small digits, and OCR did not recover five of them — 1 in
// "הוצמדו לדירות שנמכרו" and 4 in "נותרו בבעלות חוף הכרמל".
//
// Whoever recovers those five markings must update this constant DELIBERATELY,
// in the same commit that adds the doubles. It is pinned, not tolerant: closing
// the gap in the data without closing it here turns the check red on purpose.
const KNOWN_GAP = {
  developer_sold_apartments:   { spots: -1, doubles: -1, places: -2 },
  developer_retained:          { spots: +1, doubles: -4, places: -3 },
  __total__:                   { spots:  0, doubles: -5, places: -5 },
};

const CATEGORY_SQL = `
  case
    when owner_type = 'apartment' and sale_status = 'sold'       then 'committee_sold'
    when owner_type = 'apartment' and sale_status = 'in_process' then 'committee_in_process'
    when owner_type = 'committee'                                then 'committee_for_sale'
    when owner_type = 'apartment'
     and apartment_number = any(array[${UNSOLD.map((a) => `'${a}'`).join(',')}]) then 'developer_unsold_apartments'
    when owner_type = 'apartment'                                then 'developer_sold_apartments'
    else                                                              'developer_retained'
  end`;

const num = (v) => Number(v ?? 0);
const gapOf = (a, e) => ({ spots: a.spots - e.spots, doubles: a.doubles - e.doubles, places: a.places - e.places });
const sameGap = (g, k) => g.spots === k.spots && g.doubles === k.doubles && g.places === k.places;
const zero = { spots: 0, doubles: 0, places: 0 };
const fmtGap = (g) => `חניות ${g.spots >= 0 ? '+' : ''}${g.spots} · כפולות ${g.doubles >= 0 ? '+' : ''}${g.doubles} · מקומות ${g.places >= 0 ? '+' : ''}${g.places}`;

run('check-parking', async () => {
  const seeded = num(psql(`select count(*) from public.parking_spots where lot_code = '${LOT}'`));
  if (seeded === 0) {
    info(`חניון ${LOT} עדיין לא נזרע — אין מה לבדוק`);
    return;
  }
  info(`חניון ${LOT}: ${seeded} שורות`);

  // ── A. structural ──────────────────────────────────────────────────────
  const orphanSpots = num(psql(`
    select count(*) from public.parking_spots p
     where p.is_active and p.apartment_number is not null
       and not exists (select 1 from public.contacts c
                        where c.apartment_number = p.apartment_number)`));
  const orphanUnits = num(psql(`
    select count(*) from public.storage_units s
     where s.is_active and s.apartment_number is not null
       and not exists (select 1 from public.contacts c
                        where c.apartment_number = s.apartment_number)`));
  if (orphanSpots === 0) ok('כל החניות המשויכות לדירה מצביעות על דירה קיימת ב-contacts');
  else fail(`${orphanSpots} חניות משויכות למספר דירה שאינו קיים ב-contacts`);
  if (orphanUnits === 0) ok('כל המחסנים המשויכים לדירה מצביעים על דירה קיימת ב-contacts');
  else fail(`${orphanUnits} מחסנים משויכים למספר דירה שאינו קיים ב-contacts`);

  const linkViolations = num(psql(`
    select count(*) from public.parking_spots
     where (owner_type = 'apartment') <> (apartment_number is not null)`));
  if (linkViolations === 0) ok('שיוך ומספר דירה עקביים בכל השורות');
  else fail(`${linkViolations} שורות שבהן owner_type ומספר הדירה אינם עקביים`);

  const capacityViolations = num(psql(`
    select count(*) from public.parking_spots
     where capacity <> (case when size_type = 'single' then 1 else 2 end)`));
  if (capacityViolations === 0) ok('capacity תואם ל-size_type בכל השורות');
  else fail(`${capacityViolations} שורות עם capacity שאינו תואם ל-size_type`);

  const gaps = psql(`
    select count(*) from generate_series(1, ${seeded}) g
     where not exists (select 1 from public.parking_spots
                        where lot_code = '${LOT}' and spot_number = g)`);
  if (num(gaps) === 0) ok(`מספרי החניות רציפים 1..${seeded} ללא חורים`);
  else info(`${gaps} מספרים חסרים ברצף 1..${seeded} (ייתכן שתקין אם החניון אינו ממוספר ברצף)`);

  // ── B. document comparison ─────────────────────────────────────────────
  const raw = psql(`
    select ${CATEGORY_SQL} as k,
           count(*)::int,
           count(*) filter (where size_type <> 'single')::int,
           coalesce(sum(capacity),0)::int
      from public.parking_spots
     where is_active and lot_code = '${LOT}'
     group by 1`, { args: ['-tAF|', '-c'] });

  const actual = {};
  for (const line of String(raw).trim().split('\n').filter(Boolean)) {
    const [k, s, d, p] = line.split('|');
    actual[k] = { spots: num(s), doubles: num(d), places: num(p) };
  }

  console.log('');
  console.log('  בעלות וסטטוס                          חניות      כפולות     מקומות');
  console.log('  ' + '─'.repeat(74));
  let unexpected = 0;
  for (const [key, exp] of Object.entries(EXPECTED)) {
    const a = actual[key] ?? { spots: 0, doubles: 0, places: 0 };
    const gap = gapOf(a, exp);
    const known = KNOWN_GAP[key] ?? zero;
    const isKnown = sameGap(gap, known);
    const mark = sameGap(gap, zero) ? '✓' : (isKnown ? '⚠' : '✗');
    if (!isKnown) unexpected++;
    const cell = (av, ev) => `${String(av).padStart(3)}/${String(ev).padEnd(4)}`;
    console.log(`  ${mark} ${exp.label.padEnd(34)} ${cell(a.spots, exp.spots)}  ${cell(a.doubles, exp.doubles)}  ${cell(a.places, exp.places)}`);
  }

  const tot = Object.values(actual).reduce(
    (acc, v) => ({ spots: acc.spots + v.spots, doubles: acc.doubles + v.doubles, places: acc.places + v.places }),
    { spots: 0, doubles: 0, places: 0 },
  );
  const totGap = gapOf(tot, EXPECTED_TOTAL);
  const totKnown = sameGap(totGap, KNOWN_GAP.__total__);
  if (!totKnown) unexpected++;
  console.log('  ' + '─'.repeat(74));
  console.log(`  ${sameGap(totGap, zero) ? '✓' : (totKnown ? '⚠' : '✗')} ${'סה״כ'.padEnd(34)} ${String(tot.spots).padStart(3)}/${String(EXPECTED_TOTAL.spots).padEnd(4)}  ${String(tot.doubles).padStart(3)}/${String(EXPECTED_TOTAL.doubles).padEnd(4)}  ${String(tot.places).padStart(3)}/${String(EXPECTED_TOTAL.places).padEnd(4)}`);
  console.log('');

  if (unexpected === 0) {
    ok('הפער מול המסמך תואם בדיוק לפער ה-OCR המתועד (5 כפולות חסרות)');
    info('⚠ = סטייה ידועה ומאושרת, לא תקלה. ✗ = סטייה חדשה שדורשת בדיקה.');
  } else {
    fail(`${unexpected} שורות עם סטייה שאינה הפער המתועד — הנתונים השתנו, יש לבדוק`);
  }
});
