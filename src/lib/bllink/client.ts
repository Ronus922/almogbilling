import 'server-only';
import { srpAuth } from './cognito-srp';
import type { ContactWritableFields } from '@/lib/types/contacts';

/**
 * Bllink residents (tenants) client — Slice 4 Track B.
 *
 * Uses a SEPARATE Bllink endpoint from the existing debts sync:
 *   tenants → /api/v1/managers/buildings/{building}/tenants   (this file)
 *   debts   → /api/v1/managers/debts/per_building/{building}  (NOT touched here)
 */

const BLLINK_API_BASE = 'https://api.bllink.co';
const BLLINK_BUILDING_ID = 'udnp';

/**
 * A Bllink tenant row. The Bllink schema is not officially documented — these
 * are the fields we read (all optional, several alias spellings). Extra fields
 * are preserved via the index signature; we just don't depend on them. The
 * first run logs a sample so the real shape can be confirmed before the schema
 * is treated as stable.
 */
export interface BllinkTenantRow {
  apartmentNumber?: string | number;
  apartment_number?: string | number;
  apt?: string | number;
  unit?: string | number;
  unitNumber?: string | number;
  ownerName?: string;
  owner_name?: string;
  ownerPhone?: string;
  owner_phone?: string;
  phone?: string;
  tenantDetails?: {
    RenterName?: string;
    RenterPhone?: string;
    tenantName?: Array<{ tenantName?: string }>;
  };
  [key: string]: unknown;
}

export async function fetchBllinkTenants(): Promise<BllinkTenantRow[]> {
  const username = process.env.BLLINK_USERNAME;
  const password = process.env.BLLINK_PASSWORD;
  if (!username || !password) throw new Error('BLLINK credentials not configured');

  const token = await srpAuth(username, password);

  const url = `${BLLINK_API_BASE}/api/v1/managers/buildings/${BLLINK_BUILDING_ID}/tenants`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      // Bllink requires this header (seen in the manager UI's request headers).
      Ismanager: 'true',
      Accept: 'application/json',
      // Sent in case the server validates the origin for CORS.
      Origin: 'https://app.bllink.co',
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Bllink tenants fetch failed: ${response.status} ${body.slice(0, 300)}`);
  }

  const json: unknown = await response.json();

  let rows: BllinkTenantRow[] | null = null;
  if (Array.isArray(json)) {
    rows = json as BllinkTenantRow[];
  } else if (json && typeof json === 'object') {
    const obj = json as Record<string, unknown>;
    for (const key of ['data', 'value', 'tenants', 'apartments', 'results']) {
      if (Array.isArray(obj[key])) {
        rows = obj[key] as BllinkTenantRow[];
        break;
      }
    }
    if (!rows) {
      throw new Error(`Bllink tenants: unrecognized response shape, keys=${Object.keys(obj).join(',')}`);
    }
  } else {
    throw new Error(`Bllink tenants: unexpected response type ${typeof json}`);
  }

  // TEMPORARY schema-debug logs — keep until the tenants schema is confirmed
  // stable on the first real run, then remove (tracked as a TODO in PROJECT_CONTEXT).
  if (rows.length > 0) {
    // eslint-disable-next-line no-console
    console.log('[fetchBllinkTenants] sample keys:', Object.keys(rows[0]).join(', '));
    // eslint-disable-next-line no-console
    console.log('[fetchBllinkTenants] sample row:', JSON.stringify(rows[0]).slice(0, 800));
  }

  return rows;
}

/**
 * Map a Bllink tenant row to the contact fields this sync owns. Returns a
 * Partial — empty/placeholder values are filtered out so they line up with the
 * upsert's allowedFields whitelist. Returns {} (no apartment_number) when the
 * apartment can't be determined, so the caller can skip the row.
 *
 * NOTE: owner_name comes ONLY from ownerName/owner_name — it deliberately does
 * NOT fall back to tenantDetails.RenterName (that fallback is a Base44 bug).
 */
export function mapBllinkTenantToContact(row: BllinkTenantRow): Partial<ContactWritableFields> {
  const result: Partial<ContactWritableFields> = {};

  const aptRaw =
    row.apartmentNumber ?? row.apartment_number ?? row.apt ?? row.unit ?? row.unitNumber;
  const apt = aptRaw === null || aptRaw === undefined ? '' : String(aptRaw).trim();
  if (!apt) return {}; // caller sees no apartment_number → skip

  result.apartment_number = apt;

  const ownerName = row.ownerName ?? row.owner_name;
  if (ownerName && String(ownerName).trim()) result.owner_name = String(ownerName).trim();

  const ownerPhoneRaw = row.ownerPhone ?? row.owner_phone ?? row.phone;
  const ownerPhone = ownerPhoneRaw ? String(ownerPhoneRaw).trim() : '';
  if (ownerPhone && ownerPhone !== '000000000') result.owner_phone = ownerPhone;

  const tenantNameRaw = row.tenantDetails?.RenterName ?? row.tenantDetails?.tenantName?.[0]?.tenantName;
  if (tenantNameRaw && String(tenantNameRaw).trim()) result.tenant_name = String(tenantNameRaw).trim();

  const tenantPhoneRaw = row.tenantDetails?.RenterPhone;
  const tenantPhone = tenantPhoneRaw ? String(tenantPhoneRaw).trim() : '';
  if (tenantPhone && tenantPhone !== '000000000') result.tenant_phone = tenantPhone;

  return result;
}
