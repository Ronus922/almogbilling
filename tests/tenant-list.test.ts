import { describe, expect, it } from 'vitest';
import { extractTenantContacts } from '@/lib/sync/tenantList';

// Bllink's resident-list payload — the source of every CONTACT field since
// 30/09/2026, and of the address since 29/09. Fixtures are the real shapes of
// those reads: 290 apartments, 615 owners and 272 renters, every one of them
// active, and twelve apartments holding two owners with DIFFERENT addresses.
//
// What this pins is the picking rule. It has to be stable above all else: an
// unstable pick would propose one value on Monday and the other on Tuesday,
// and a rejection would never stick.

const person = (over: Record<string, unknown> = {}) => ({
  tenant: { id: 1, isPrimary: false, isActive: true, ...(over.tenant as object ?? {}) },
  details: { tenantType: 'owner', name: 'x', phone: '0500000000', email: null, ...(over.details as object ?? {}) },
});
const EMPTY = {
  owner_name: null, owner_phone: null, owner_email: null,
  tenant_name: null, tenant_phone: null, tenant_email: null,
};
const payload = (...apartments: unknown[]) => ({ apartments });

describe("Bllink's resident list → one value per apartment per role per field", () => {
  it('reads the owner and the renter into their own fields — name, phone and address', () => {
    // Apartment 1001 as the live list holds it: the OWNER, whom the export's
    // single name cell never mentions (it prints the tenant alone there, as
    // it does for 53 of the 219 apartments).
    const out = extractTenantContacts(payload({
      apartmentNum: '1001',
      tenants: [
        person({
          tenant: { id: 361381, isPrimary: false },
          details: { tenantType: 'owner', name: 'אמיר רימון', phone: '543195988', email: null },
        }),
        person({
          tenant: { id: 383382, isPrimary: true },
          details: { tenantType: 'renter', name: "כרמל ביץ' אפרטמנטס- טלי אראל  ", phone: '0523729666', email: 'tali_e001@walla.com' },
        }),
      ],
    }));
    expect(out.get('1001')).toEqual({
      owner_name: 'אמיר רימון',
      // RAW as Bllink holds it — the missing leading zero is the mapper's job.
      owner_phone: '543195988',
      owner_email: null,
      tenant_name: "כרמל ביץ' אפרטמנטס- טלי אראל",
      tenant_phone: '0523729666',
      tenant_email: 'tali_e001@walla.com',
    });
  });

  it('prefers the primary contact, then the lower id — the same pick every morning', () => {
    const apt = {
      apartmentNum: '1013',
      tenants: [
        person({ tenant: { id: 900, isPrimary: false }, details: { email: 'second@elron.org' } }),
        person({ tenant: { id: 800, isPrimary: true }, details: { email: 'primary@elron.org' } }),
      ],
    };
    expect(extractTenantContacts(payload(apt)).get('1013')?.owner_email).toBe('primary@elron.org');
    // reversed order, same answer
    expect(extractTenantContacts(payload({ ...apt, tenants: [...apt.tenants].reverse() }))
      .get('1013')?.owner_email).toBe('primary@elron.org');

    // neither primary → the lower id wins, whichever order they arrive in
    const neither = {
      apartmentNum: '1029',
      tenants: [
        person({ tenant: { id: 700 }, details: { email: 'ylskii@mail.ru' } }),
        person({ tenant: { id: 600 }, details: { email: 'yelskii@mail.ru' } }),
      ],
    };
    expect(extractTenantContacts(payload(neither)).get('1029')?.owner_email).toBe('yelskii@mail.ru');
    expect(extractTenantContacts(payload({ ...neither, tenants: [...neither.tenants].reverse() }))
      .get('1029')?.owner_email).toBe('yelskii@mail.ru');
  });

  it('skips a deactivated person, a blank value and a role it does not know', () => {
    const out = extractTenantContacts(payload({
      apartmentNum: '777',
      tenants: [
        person({ tenant: { id: 1, isPrimary: true, isActive: false }, details: { name: 'gone', email: 'gone@example.com' } }),
        person({ tenant: { id: 2 }, details: { name: '   ', email: '   ' } }),
        person({ tenant: { id: 3 }, details: { tenantType: 'operator', name: 'op', email: 'operator@example.com' } }),
        person({ tenant: { id: 4 }, details: { name: ' Keeper ', email: ' keeper@example.com ' } }),
      ],
    }));
    expect(out.get('777')).toMatchObject({
      owner_name: 'Keeper', owner_email: 'keeper@example.com', tenant_name: null, tenant_email: null,
    });
    // The deactivated primary does not win anything, not even the phone.
    expect(out.get('777')?.owner_phone).toBe('0500000000');
  });

  it('a name and a phone always come from the SAME person', () => {
    // Measured on the live list of 30/09/2026: in all 442 role-slots the
    // person carrying the name is the person carrying the phone. The pick is
    // per field, so this asserts the rule agrees with itself.
    const out = extractTenantContacts(payload({
      apartmentNum: '504',
      tenants: [
        person({ tenant: { id: 2, isPrimary: false }, details: { name: 'רננה מילשטיין', phone: '528513340' } }),
        person({ tenant: { id: 1, isPrimary: true }, details: { name: 'אלי - הבת רננה מילשטיין', phone: '0528513340' } }),
      ],
    }));
    expect(out.get('504')).toMatchObject({
      owner_name: 'אלי - הבת רננה מילשטיין', owner_phone: '0528513340',
    });
  });

  it('an apartment with nothing at all is simply absent', () => {
    const out = extractTenantContacts(payload(
      { apartmentNum: '100', tenants: [person({ details: { name: null, phone: null, email: null } })] },
      { apartmentNum: '101', tenants: [person({ details: { email: 'a@b.co' } })] },
    ));
    expect(out.has('100')).toBe(false);
    expect(out.has('101')).toBe(true);
  });

  it('a payload that is not what we expect yields nothing, never a throw', () => {
    for (const bad of [null, undefined, {}, [], 'nope', { apartments: null }, { apartments: {} }]) {
      expect(extractTenantContacts(bad).size).toBe(0);
    }
    expect(EMPTY.owner_name).toBeNull();
    // a well-shaped envelope full of rubbish is empty, not an exception
    expect(extractTenantContacts({ apartments: [null, { tenants: 'no' }, { apartmentNum: '' }] }).size).toBe(0);
  });
});
