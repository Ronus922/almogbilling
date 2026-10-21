// Visual ordering of mixed Hebrew / Latin / digits text for jsPDF.
//
// jsPDF paints glyphs strictly left-to-right with no bidi support. Reversing the
// whole string (what the older debtors export does) turns every number and every
// English word into mirror-writing ("1,250" → "052,1"). This module resolves a
// LOGICAL string into the VISUAL string for a right-to-left paragraph:
//   • Hebrew runs are reversed (and their brackets mirrored);
//   • digits / Latin runs (phone numbers, dates, e-mail, ₪1,250.00) keep their
//     internal order;
//   • the runs are laid out right-to-left.
// Neutrals (spaces, punctuation) take the direction of the runs around them and
// fall back to RTL between two different directions — the Unicode rule that
// matters for the text of these documents. Pure; no dependency.

type Dir = 'R' | 'L';

const MIRROR: Record<string, string> = {
  '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<',
};

function isHebrew(c: string): boolean {
  const n = c.charCodeAt(0);
  return (n >= 0x0590 && n <= 0x05ff) || (n >= 0xfb1d && n <= 0xfb4f);
}

function isLatinOrDigit(c: string): boolean {
  return /[A-Za-z0-9À-ɏ₪$€]/.test(c);
}

/** Punctuation that stays inside a number / e-mail / URL when both neighbours
 *  are LTR (04-8123456, 21/10/2026, 1,250.00, a@b.co.il). */
const LTR_JOINERS = new Set(['.', ',', ':', '/', '-', '@', '+', '%', '_', '#', '&', '=', '?']);

function resolveDirections(chars: readonly string[], base: Dir): Dir[] {
  const n = chars.length;
  const dir: Array<Dir | null> = chars.map((c) => (isHebrew(c) ? 'R' : isLatinOrDigit(c) ? 'L' : null));

  // Joiners between two LTR characters belong to the LTR run.
  for (let i = 1; i < n - 1; i++) {
    if (dir[i] === null && LTR_JOINERS.has(chars[i]) && dir[i - 1] === 'L' && isLatinOrDigit(chars[i + 1])) {
      dir[i] = 'L';
    }
  }

  // A percent sign closing a number stays with it ("18%" — not "%18").
  for (let i = 1; i < n; i++) {
    if (dir[i] === null && chars[i] === '%' && dir[i - 1] === 'L') dir[i] = 'L';
  }

  // Remaining neutrals: the surrounding strong direction when both sides agree,
  // else the paragraph direction.
  let i = 0;
  while (i < n) {
    if (dir[i] !== null) { i++; continue; }
    let j = i;
    while (j < n && dir[j] === null) j++;
    const before = i > 0 ? dir[i - 1] : null;
    const after = j < n ? dir[j] : null;
    const d: Dir = before !== null && before === after ? before : base;
    for (let k = i; k < j; k++) dir[k] = d;
    i = j;
  }
  return dir as Dir[];
}

/**
 * The string to hand to `doc.text` so that, painted left-to-right, a
 * right-to-left reader sees the logical text in order. `base` is the paragraph
 * direction ('R' for these Hebrew documents).
 */
export function toVisual(logical: string, base: Dir = 'R'): string {
  if (!logical) return '';
  const chars = Array.from(logical);
  const dir = resolveDirections(chars, base);

  const runs: Array<{ dir: Dir; text: string }> = [];
  for (let i = 0; i < chars.length; i++) {
    const last = runs[runs.length - 1];
    if (last && last.dir === dir[i]) last.text += chars[i];
    else runs.push({ dir: dir[i], text: chars[i] });
  }

  const painted = runs.map((r) =>
    r.dir === 'R'
      ? Array.from(r.text).reverse().map((c) => MIRROR[c] ?? c).join('')
      : r.text,
  );
  // Base RTL: the first logical run is the right-most on the page.
  return (base === 'R' ? painted.reverse() : painted).join('');
}

/**
 * Greedy word wrap on the LOGICAL text. `measure` is the width of a logical
 * string (the glyph widths do not depend on order, so measuring before
 * reordering is exact). Every returned line is still logical — pass it through
 * toVisual() when painting. Honors explicit newlines; a single word wider than
 * the box is broken by character.
 */
export function wrapLogical(text: string, measure: (s: string) => number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (para.trim() === '') { out.push(''); continue; }
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate) <= maxWidth) { line = candidate; continue; }
      if (line) out.push(line);
      if (measure(word) <= maxWidth) { line = word; continue; }
      // An over-long token (a URL, a serial number): break it by character.
      let chunk = '';
      for (const ch of Array.from(word)) {
        if (measure(chunk + ch) > maxWidth && chunk) { out.push(chunk); chunk = ch; } else chunk += ch;
      }
      line = chunk;
    }
    out.push(line);
  }
  return out;
}
