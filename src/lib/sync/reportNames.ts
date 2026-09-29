/**
 * The Bllink report's name cell, split by role — the twin of
 * splitOwnerTenantPhones (src/lib/whatsapp.ts) for names.
 *
 * WHY (found 29/09/2026, dry run of the suggestion queue on a copy of
 * production): the report's name column is not an owner name. It carries the
 * owner AND the tenant in one string, each tagged, and sometimes only the
 * tenant:
 *
 *   "ס נ נדל״ן  (בעלים)"                              → owner
 *   "בלכנר חנה (בעלים) אור מזוז דירות נופש (שוכר/ת)"  → owner + tenant
 *   "אור מזוז (שוכר/ת)"                                → tenant only, no owner
 *
 * Until the queue existed this only ever filled a brand-new apartment's card,
 * so nobody noticed. Fed to the queue raw it produced 217 suggestions on 220
 * apartments — nearly all of them noise, and approving one would have written
 * a TENANT's name into the owner field. Split by the labels the report itself
 * prints, 217 became 12.
 *
 * Rules, deliberately the same as the phone splitter's: the first "(בעלים)"
 * wins the owner, the first "(שוכר)"/"(שוכר/ת)" wins the tenant, a label that
 * is neither is part of the name ("חברה (2010) בע״מ"), and a cell with no label
 * at all is the owner — which is exactly what the whole cell used to mean.
 * A role with no name before it yields null rather than a guess.
 */

const OWNER_LABEL = /בעל/;
const TENANT_LABEL = /שוכר/;

function clean(s: string): string | null {
  const t = s.replace(/\s+/g, ' ').trim().replace(/^[-–—,;/]+|[-–—,;/]+$/g, '').trim();
  return t === '' ? null : t;
}

export function splitOwnerTenantNames(
  raw: string | null | undefined,
): { owner: string | null; tenant: string | null } {
  if (raw == null) return { owner: null, tenant: null };

  let owner: string | null = null;
  let tenant: string | null = null;
  const unlabeled: string[] = [];

  // Everything read since the last role label. A non-role parenthesis is put
  // back verbatim, so it stays part of the name it belongs to.
  let buffer = '';
  let last = 0;
  const re = /\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const segment = raw.slice(last, m.index);
    last = re.lastIndex;
    const label = m[1] ?? '';
    if (OWNER_LABEL.test(label) || TENANT_LABEL.test(label)) {
      const name = clean(buffer + segment);
      if (name) {
        if (OWNER_LABEL.test(label)) owner ??= name;
        else tenant ??= name;
      }
      buffer = '';
    } else {
      buffer += `${segment}(${label})`;
    }
  }

  const tail = clean(buffer + raw.slice(last));
  if (tail) unlabeled.push(tail);

  // An unlabelled cell is the owner — the meaning the whole cell had before.
  if (!owner && unlabeled.length > 0) owner = unlabeled.shift() ?? null;
  if (!tenant && unlabeled.length > 0) tenant = unlabeled.shift() ?? null;

  return { owner, tenant };
}
