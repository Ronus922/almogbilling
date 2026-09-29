import { describe, expect, it } from 'vitest';
import { extractTenantEmails } from '@/lib/sync/tenantList';

// Bllink's resident-list payload — the ONE place in Bllink that carries an
// address (Phase 0, 29/09/2026: the debt export billing scrapes is nine
// columns wide and has none). Fixtures are the real shapes of the 29/09 read:
// 290 apartments, 615 owners and 272 renters, every one of them active, and
// twelve apartments holding two owners with DIFFERENT addresses.
//
// What this pins is the picking rule. It has to be stable above all else: an
// unstable pick would propose one address on Monday and the other on Tuesday,
// and a rejection would never stick.

const person = (over: Record<string, unknown> = {}) => ({
  tenant: { id: 1, isPrimary: false, isActive: true, ...(over.tenant as object ?? {}) },
  details: { tenantType: 'owner', name: 'x', phone: '0500000000', email: null, ...(over.details as object ?? {}) },
});
const payload = (...apartments: unknown[]) => ({ apartments });

describe("Bllink's resident list → one address per apartment per role", () => {
  it('reads the owner and the renter into their own fields', () => {
    const out = extractTenantEmails(payload({
      apartmentNum: '1001',
      tenants: [
        person({ tenant: { id: 361381, isPrimary: false }, details: { tenantType: 'owner', email: null } }),
        person({ tenant: { id: 383382, isPrimary: true }, details: { tenantType: 'renter', email: 'tali_e001@walla.com' } }),
      ],
    }));
    expect(out.get('1001')).toEqual({ owner_email: null, tenant_email: 'tali_e001@walla.com' });
  });

  it('prefers the primary contact, then the lower id — the same pick every morning', () => {
    const apt = {
      apartmentNum: '1013',
      tenants: [
        person({ tenant: { id: 900, isPrimary: false }, details: { email: 'second@elron.org' } }),
        person({ tenant: { id: 800, isPrimary: true }, details: { email: 'primary@elron.org' } }),
      ],
    };
    expect(extractTenantEmails(payload(apt)).get('1013')?.owner_email).toBe('primary@elron.org');
    // reversed order, same answer
    expect(extractTenantEmails(payload({ ...apt, tenants: [...apt.tenants].reverse() }))
      .get('1013')?.owner_email).toBe('primary@elron.org');

    // neither primary → the lower id wins, whichever order they arrive in
    const neither = {
      apartmentNum: '1029',
      tenants: [
        person({ tenant: { id: 700 }, details: { email: 'ylskii@mail.ru' } }),
        person({ tenant: { id: 600 }, details: { email: 'yelskii@mail.ru' } }),
      ],
    };
    expect(extractTenantEmails(payload(neither)).get('1029')?.owner_email).toBe('yelskii@mail.ru');
    expect(extractTenantEmails(payload({ ...neither, tenants: [...neither.tenants].reverse() }))
      .get('1029')?.owner_email).toBe('yelskii@mail.ru');
  });

  it('skips a deactivated person, a blank address and a role it does not know', () => {
    const out = extractTenantEmails(payload({
      apartmentNum: '777',
      tenants: [
        person({ tenant: { id: 1, isPrimary: true, isActive: false }, details: { email: 'gone@example.com' } }),
        person({ tenant: { id: 2 }, details: { email: '   ' } }),
        person({ tenant: { id: 3 }, details: { tenantType: 'operator', email: 'operator@example.com' } }),
        person({ tenant: { id: 4 }, details: { email: ' keeper@example.com ' } }),
      ],
    }));
    expect(out.get('777')).toEqual({ owner_email: 'keeper@example.com', tenant_email: null });
  });

  it('an apartment with no address at all is simply absent', () => {
    const out = extractTenantEmails(payload(
      { apartmentNum: '100', tenants: [person()] },
      { apartmentNum: '101', tenants: [person({ details: { email: 'a@b.co' } })] },
    ));
    expect(out.has('100')).toBe(false);
    expect(out.has('101')).toBe(true);
  });

  it('a payload that is not what we expect yields nothing, never a throw', () => {
    for (const bad of [null, undefined, {}, [], 'nope', { apartments: null }, { apartments: {} }]) {
      expect(extractTenantEmails(bad).size).toBe(0);
    }
    // a well-shaped envelope full of rubbish is empty, not an exception
    expect(extractTenantEmails({ apartments: [null, { tenants: 'no' }, { apartmentNum: '' }] }).size).toBe(0);
  });
});
