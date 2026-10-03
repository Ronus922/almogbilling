// What a BLOCKED phone's names look like — a suggestion for the person on the
// "טלפונים חסומים" screen, never a decision (03/10/2026, "סיווג אוטומטי").
//
// The screen offers two actions per phone: "אדם אחד" (approve one identity) and
// detaching a link. Which one is right depends on WHY the names differ, and
// that is usually visible from the names themselves:
//
//   spelling         — the same name written differently: word order, a
//                      punctuation mark, a letter, a short form ("יוסי" /
//                      "פרידמן יוסי") → probably "אדם אחד";
//   company_contact  — a company and a person ("ס.נ נדל״ן" / "סוניה") → often
//                      the person authorised for the company;
//   family           — family words ("אמא", "הבן") or names that share a word
//                      but are not one spelling of each other → relatives;
//   unrelated        — nothing in common, or someone answered "a different
//                      person" when the phone was typed in → a suspected
//                      typing mistake: detach the wrong link;
//   missing_name     — a link with no name at all: nothing to compare.
//
// Pure and isomorphic; tested directly.

export type BlockedPhoneCategory = 'spelling' | 'company_contact' | 'family' | 'unrelated' | 'missing_name';

export const BLOCKED_PHONE_CATEGORY_LABEL: Record<BlockedPhoneCategory, string> = {
  spelling: 'כתיב שונה של אותו שם',
  company_contact: 'חברה + איש קשר',
  family: 'משפחה',
  unrelated: 'שמות ללא קשר — חשד לטעות הזנה',
  missing_name: 'חסר שם ברשומה',
};

const COMPANY_RE = /בע["'״׳]?מ|חברת|חברה|נכסים|השקעות|נדל["'״׳]?ן|נדלן|גרופ|group|ltd|מלון|נופש|דירות|סוויטות|אחזקות|ניהול|אנליטיקל|שיווק|אנרגיה|יזמות|בנין|בניין/i;
const FAMILY_WORDS = new Set(['אמא', 'אבא', 'הבן', 'הבת', 'אשת', 'אישה', 'בעלה', 'אשתו', 'סבא', 'סבתא', 'אח', 'אחות', 'נכד', 'נכדה', 'הורים', 'משפחת']);
/** Words that carry no identity: dates, "from", "in the care of". */
const NOISE_WORDS = new Set(['מ', 'החל', 'מתאריך', 'בטיפול', 'של', 'עבודה', 'בית', 'נייד']);

/** Letters only, per word; dates, digits and punctuation dropped. */
export function nameTokens(name: string): string[] {
  return name
    .replace(/[0-9]+([./-][0-9]+)*/g, ' ')
    .replace(/["'״׳`.,()\[\]{}:;\-–—/\\|+]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0 && !NOISE_WORDS.has(t));
}

function letters(name: string): string {
  return nameTokens(name).join('');
}

/** Edit distance with adjacent swaps counted once ("נזיה" / "נזהי" = 1). */
function distance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
      }
    }
  }
  return dp[a.length][b.length];
}

/** The same word, allowing one slip in four letters or more, two in six or
 *  more. Shorter words must match exactly ("לי" is not "לוי"). */
function closeToken(a: string, b: string): boolean {
  if (a === b) return true;
  const max = Math.max(a.length, b.length);
  if (max < 4) return false;
  return distance(a, b) <= (max >= 6 ? 2 : 1);
}

/** Every token of `few` has a close token in `many`. */
function covered(few: string[], many: string[]): boolean {
  return few.length > 0 && few.every((t) => many.some((u) => closeToken(t, u)));
}

/** "ו" joins a second person: "ברכה בריל ואברהם קליין". */
function joinsAnother(tokens: string[]): boolean {
  return tokens.slice(1).some((t) => t.startsWith('ו') && t.length > 2);
}

type PairCategory = Exclude<BlockedPhoneCategory, 'missing_name'>;

function classifyPair(a: string, b: string): PairCategory {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.some((t) => FAMILY_WORDS.has(t)) || tb.some((t) => FAMILY_WORDS.has(t))) return 'family';
  const ca = COMPANY_RE.test(a);
  const cb = COMPANY_RE.test(b);
  if (letters(a) === letters(b)) return 'spelling';
  const [few, many] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (covered(few, many)) {
    // A subset that adds ANOTHER person ("… ואברהם קליין") is two people.
    if (few.length < many.length && joinsAnother(many)) return 'family';
    if (ca === cb) return 'spelling';
  }
  if (ca !== cb) return 'company_contact';
  if (ta.some((t) => t.length > 1 && tb.some((u) => closeToken(t, u)))) return ca ? 'spelling' : 'family';
  return 'unrelated';
}

const SEVERITY: PairCategory[] = ['spelling', 'family', 'company_contact', 'unrelated'];

/**
 * The category of one blocked phone, from the names on its links.
 * `entryFlagged` = someone answered "a different person" when it was typed in.
 *
 * With three names or more, a pair with nothing in common does not decide on
 * its own — "אלירן סלע", "דוריס סלע בינימין" and "דוריס" hang together through
 * the middle one. The names are joined by their closest relations first (the
 * least severe pairs, Kruskal's way); the answer is the most severe relation
 * that was needed to join them all, and "unrelated" when they cannot be.
 */
export function classifyBlockedPhone(
  names: ReadonlyArray<string | null>,
  entryFlagged = false,
): BlockedPhoneCategory {
  const clean = names.map((n) => (n ?? '').trim().replace(/\s+/g, ' '));
  if (clean.some((n) => n === '')) return 'missing_name';
  if (entryFlagged) return 'unrelated';
  const distinct = [...new Set(clean)];
  if (distinct.length < 2) return 'spelling';

  const edges: { i: number; j: number; sev: number }[] = [];
  for (let i = 0; i < distinct.length; i++) {
    for (let j = i + 1; j < distinct.length; j++) {
      edges.push({ i, j, sev: SEVERITY.indexOf(classifyPair(distinct[i], distinct[j])) });
    }
  }
  edges.sort((a, b) => a.sev - b.sev);
  const parent = distinct.map((_, k) => k);
  const root = (k: number): number => (parent[k] === k ? k : (parent[k] = root(parent[k])));
  let joined = 1;
  let worst = 0;
  for (const e of edges) {
    const a = root(e.i);
    const b = root(e.j);
    if (a === b) continue;
    parent[a] = b;
    joined += 1;
    worst = Math.max(worst, e.sev);
    if (joined === distinct.length) break;
  }
  return SEVERITY[worst];
}
