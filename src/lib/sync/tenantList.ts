/**
 * Bllink's "רשימת דיירים" report — the source of every CONTACT field since
 * 30/09/2026, and of the email since 29/09.
 *
 * Why it replaced the debt export for people. The export carries ONE name
 * cell and ONE phone cell per apartment, holding whichever single person
 * Bllink chose to print, behind "(בעלים)" / "(שוכר/ת)" labels that are
 * sometimes missing altogether. Very often that person is the tenant and the
 * owner is simply absent: on the snapshot of 30/09/2026, 53 of 219 apartments
 * name NO owner in the export while the resident list knows one. The list has
 * one entry per PERSON with an explicit role and a primary-contact flag — no
 * labels to parse, both roles, and a phone that belongs to the name beside it.
 *
 * What it does NOT fix: a name Bllink itself holds truncated. Apartment 514
 * reads "' אפרטמנטס- טלי אראל" in the resident list too — the export was
 * carrying that faithfully, not cutting it. (PR #52's report said the export
 * truncates; it compared two different apartments and was wrong. Corrected
 * here on the evidence of the 30/09 dry run.)
 *
 * It is the same screen and the same request either way:
 *   GET https://api.bllink.co/api/v1/managers/buildings/<building>/tenants
 * driven by /reports/tenant-list/<building> on the session the scraper is
 * already signed into. The debt export stays the source of truth for MONEY.
 *
 * Everything here is pure, so the picking rule is testable without a browser.
 */

/** Only what we read. Bllink sends a great deal more per person. */
interface RawTenantDetails {
  tenantType?: unknown;
  name?: unknown;
  phone?: unknown;
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

/** One apartment's people, flattened to the registry's own field names. Every
 *  value is RAW as Bllink holds it — normalising belongs to the mapper that
 *  both sources share (bllinkMap.mapSourceRow). */
export interface ApartmentContacts {
  owner_name: string | null;
  owner_phone: string | null;
  owner_email: string | null;
  tenant_name: string | null;
  tenant_phone: string | null;
  tenant_email: string | null;
}

export const EMPTY_CONTACTS: ApartmentContacts = {
  owner_name: null, owner_phone: null, owner_email: null,
  tenant_name: null, tenant_phone: null, tenant_email: null,
};

const text = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
};

/** Bllink's word for a tenant is "renter"; ours is "tenant". */
const ROLE: Record<string, 'owner' | 'tenant'> = { owner: 'owner', renter: 'tenant' };
const SOURCE_FIELDS = ['name', 'phone', 'email'] as const;

/**
 * One value per apartment per role per field.
 *
 * An apartment can hold several active people of the same role. The primary
 * contact wins; between two equally primary ones the lower Bllink id wins, so
 * the choice is the same every morning and a suggestion cannot flap between
 * two values — a flapping proposal would make a rejection impossible to make
 * stick.
 *
 * The pick is made per FIELD (the first person of that role who HAS one)
 * rather than per person, which finds 207 addresses instead of 192. It cannot
 * build a Frankenstein record out of two people: measured on the live list of
 * 30/09/2026, the person who carries the name and the person who carries the
 * phone are the same in all 442 role-slots, and the address is an independent
 * contact detail in any case.
 *
 * Nothing here is trusted to be well-formed: the payload is a third party's,
 * and every field is checked before it is read.
 */
export function extractTenantContacts(payload: unknown): Map<string, ApartmentContacts> {
  const out = new Map<string, ApartmentContacts>();
  const apartments = (payload as { apartments?: unknown } | null)?.apartments;
  if (!Array.isArray(apartments)) return out;

  for (const raw of apartments as RawApartment[]) {
    const apt = text(raw?.apartmentNum) ?? text(String(raw?.apartmentNum ?? ''));
    if (!apt) continue;
    const people = Array.isArray(raw?.tenants) ? (raw.tenants as RawTenant[]) : [];

    const found: ApartmentContacts = { ...EMPTY_CONTACTS };
    const best = new Map<string, { primary: boolean; id: number }>();
    let any = false;

    for (const p of people) {
      if (p?.tenant?.isActive === false) continue;
      const role = ROLE[text(p?.details?.tenantType) ?? ''];
      if (!role) continue;
      const primary = p.tenant?.isPrimary === true;
      const id = typeof p.tenant?.id === 'number' ? p.tenant.id : Number.MAX_SAFE_INTEGER;

      for (const f of SOURCE_FIELDS) {
        const value = text(p.details?.[f]);
        if (!value) continue;
        const key = `${role}_${f}` as keyof ApartmentContacts;
        const held = best.get(key);
        if (held && !(primary && !held.primary) && !(primary === held.primary && id < held.id)) continue;
        best.set(key, { primary, id });
        found[key] = value;
        any = true;
      }
    }

    if (any) out.set(apt, found);
  }
  return out;
}

/** One person of Bllink's resident list — the portal-link comparison
 *  (bllink_scrapes.list_people, migrations 20261003161749 + 20261003191659).
 *  Raw values. */
export interface ListPerson {
  role: 'owner' | 'tenant';
  name: string | null;
  phone: string | null;
  primary: boolean;
  /** isActive. An inactive person is kept so a "ניתוק" can say why. */
  active: boolean;
}

/**
 * EVERY person per apartment, not one value per field: the portal links are
 * per person, so each one is compared on its own, by phone first — an active
 * person the card does not carry becomes a "שיוך" suggestion; a linked phone
 * Bllink does not list there, or lists only with isActive = false, a "ניתוק"
 * one. Inactive people are kept (active: false) for exactly that reason, and
 * never proposed for "שיוך". An apartment the list names with nobody in it is
 * kept, empty: that IS information ("nobody lives there any more"). People
 * with neither a name nor a phone carry nothing to compare and are left out.
 */
export function extractTenantPeople(payload: unknown): Record<string, ListPerson[]> {
  const out: Record<string, ListPerson[]> = {};
  const apartments = (payload as { apartments?: unknown } | null)?.apartments;
  if (!Array.isArray(apartments)) return out;

  for (const raw of apartments as RawApartment[]) {
    const apt = text(raw?.apartmentNum) ?? text(String(raw?.apartmentNum ?? ''));
    if (!apt) continue;
    const list = out[apt] ?? [];
    const people = Array.isArray(raw?.tenants) ? (raw.tenants as RawTenant[]) : [];
    for (const p of people) {
      const role = ROLE[text(p?.details?.tenantType) ?? ''];
      if (!role) continue;
      const name = text(p.details?.name);
      const phone = text(p.details?.phone);
      if (!name && !phone) continue;
      list.push({ role, name, phone, primary: p.tenant?.isPrimary === true, active: p.tenant?.isActive !== false });
    }
    out[apt] = list;
  }
  return out;
}

