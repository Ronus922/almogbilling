/**
 * Bllink's "רשימת דיירים" report — the ONE place in Bllink that carries an
 * email address (Phase 0, 29/09/2026).
 *
 * The debt report billing has always scraped is nine columns wide and has no
 * address in any of them: דירה · דייר/ת · טלפון · סה״כ חוב · סה״כ חוב לתשלום
 * חודשי · פרטים · חוב מיוחד · פרטים · תשלום חודשי. Not one cell in the whole
 * export matches an email pattern. The addresses Ronen sees in Bllink's
 * interface live on a DIFFERENT screen — /reports/tenant-list/<building> —
 * which the page fills from
 *   GET https://api.bllink.co/api/v1/managers/buildings/<building>/tenants
 * on the very session the scraper is already signed into. 290 apartments,
 * 185 of them with at least one address.
 *
 * That payload is far richer than the report cell it feeds: one entry per
 * PERSON, with an explicit role instead of a "(בעלים)" label glued into a
 * name. Only the address is read here — the names and phones deliberately go
 * on coming from the report and its shared splitter, so this round changes one
 * thing at a time and the 47 owner-name suggestions already waiting for Ronen
 * do not move under him.
 *
 * Everything in this module is pure, so the picking rule is testable without
 * a browser.
 */

/** Only what we read. Bllink sends a great deal more per person. */
interface RawTenantDetails {
  tenantType?: unknown;
  email?: unknown;
}
interface RawTenant {
  tenant?: { isPrimary?: unknown; isActive?: unknown; id?: unknown } | null;
  details?: RawTenantDetails | null;
}
interface RawApartment {
  apartmentNum?: unknown;
  tenants?: unknown;
}

export interface ApartmentEmails {
  owner_email: string | null;
  tenant_email: string | null;
}

const text = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
};

/** Bllink's word for a tenant is "renter"; ours is "tenant". */
const ROLE: Record<string, keyof ApartmentEmails> = {
  owner: 'owner_email',
  renter: 'tenant_email',
};

/**
 * One address per apartment per role.
 *
 * An apartment can hold several people of the same role with different
 * addresses (12 of the 290 do). The primary contact wins; between two equally
 * primary ones the lower Bllink id wins, so the choice is the same every
 * morning and a suggestion cannot flap between two addresses. Where Ronen
 * disagrees with the pick he rejects it once and it does not come back.
 *
 * Nothing here is trusted to be well-formed: the payload is a third party's,
 * and every field is checked before it is read.
 */
export function extractTenantEmails(payload: unknown): Map<string, ApartmentEmails> {
  const out = new Map<string, ApartmentEmails>();
  const apartments = (payload as { apartments?: unknown } | null)?.apartments;
  if (!Array.isArray(apartments)) return out;

  for (const raw of apartments as RawApartment[]) {
    const apt = text(raw?.apartmentNum) ?? text(String(raw?.apartmentNum ?? ''));
    if (!apt) continue;
    const people = Array.isArray(raw?.tenants) ? (raw.tenants as RawTenant[]) : [];

    const best: Partial<Record<keyof ApartmentEmails, { email: string; primary: boolean; id: number }>> = {};
    for (const p of people) {
      if (p?.tenant?.isActive === false) continue;
      const field = ROLE[text(p?.details?.tenantType) ?? ''];
      if (!field) continue;
      const email = text(p?.details?.email);
      if (!email) continue;
      const primary = p.tenant?.isPrimary === true;
      const id = typeof p.tenant?.id === 'number' ? p.tenant.id : Number.MAX_SAFE_INTEGER;
      const held = best[field];
      if (!held || (primary && !held.primary) || (primary === held.primary && id < held.id)) {
        best[field] = { email, primary, id };
      }
    }

    if (best.owner_email || best.tenant_email) {
      out.set(apt, {
        owner_email: best.owner_email?.email ?? null,
        tenant_email: best.tenant_email?.email ?? null,
      });
    }
  }
  return out;
}
