import { NextResponse, type NextRequest } from 'next/server';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { query } from '@/lib/db';

export const runtime = 'nodejs';

// Unified global-search endpoint for the ⌘K command palette. One parametrised
// ILIKE query per source, LIMIT 5 each, flattened into a single typed array the
// palette groups client-side. RBAC is enforced HERE: a source the actor cannot
// view is never queried (not merely hidden in the UI). No DDL — plain ILIKE is
// enough for now (pg_trgm is a future optimisation, not a correctness need).

type SearchType = 'debtor' | 'supplier' | 'issue' | 'document';

interface SearchResult {
  type: SearchType;
  id: string;
  title: string;
  subtitle: string;
  href: string;
}

const PER_SOURCE_LIMIT = 5;

/** Escape LIKE/ILIKE wildcards so the user's text is matched literally (default
 *  escape char '\'), then wrap as a contains-pattern. */
function likePattern(q: string): string {
  const escaped = q.replace(/[\\%_]/g, (c) => `\\${c}`);
  return `%${escaped}%`;
}

function firstNonEmpty(...vals: Array<string | null | undefined>): string {
  for (const v of vals) {
    const t = v?.trim();
    if (t) return t;
  }
  return '';
}

interface DebtorRow {
  id: string;
  owner_name: string | null;
  tenant_name: string | null;
  address: string | null;
  apartment_number: string | null;
}
async function searchDebtors(pattern: string): Promise<SearchResult[]> {
  const r = await query<DebtorRow>(
    `select id, owner_name, tenant_name, address, apartment_number
       from public.debtors
      where is_archived = false
        and (owner_name ilike $1 or tenant_name ilike $1 or address ilike $1
             or apartment_number ilike $1 or phone_owner ilike $1 or phone_tenant ilike $1
             or email_owner ilike $1 or email_tenant ilike $1)
      order by owner_name nulls last
      limit ${PER_SOURCE_LIMIT}`,
    [pattern],
  );
  return r.rows.map((d) => {
    const apt = d.apartment_number?.trim();
    const subtitleParts = [apt ? `דירה ${apt}` : '', d.address?.trim() ?? ''].filter(Boolean);
    return {
      type: 'debtor' as const,
      id: d.id,
      title: firstNonEmpty(d.owner_name, d.tenant_name) || 'דייר ללא שם',
      subtitle: subtitleParts.join(' · '),
      // Existing deep-link on /dashboard: ?apt=X&open=details opens the debtor panel.
      href: apt ? `/dashboard?apt=${encodeURIComponent(apt)}&open=details` : '/dashboard',
    };
  });
}

interface SupplierRow {
  id: string;
  display_name: string | null;
  company_name: string | null;
  contact_person: string | null;
  supplier_type: string | null;
}
async function searchSuppliers(pattern: string): Promise<SearchResult[]> {
  const r = await query<SupplierRow>(
    `select id, display_name, company_name, contact_person, supplier_type
       from public.suppliers
      where deleted_at is null
        and (display_name ilike $1 or company_name ilike $1 or contact_person ilike $1
             or phone ilike $1 or mobile ilike $1 or email ilike $1
             or supplier_type ilike $1 or city ilike $1)
      order by display_name nulls last
      limit ${PER_SOURCE_LIMIT}`,
    [pattern],
  );
  return r.rows.map((s) => ({
    type: 'supplier' as const,
    id: s.id,
    title: firstNonEmpty(s.display_name, s.company_name) || 'ספק ללא שם',
    subtitle: firstNonEmpty(s.company_name, s.contact_person, s.supplier_type),
    // No per-supplier deep-link route exists — land on the suppliers list.
    href: '/suppliers',
  }));
}

interface IssueRow {
  id: string;
  title: string | null;
  location_text: string | null;
}
async function searchIssues(pattern: string): Promise<SearchResult[]> {
  const r = await query<IssueRow>(
    `select id, title, location_text
       from public.issues
      where is_archived = false
        and (title ilike $1 or description ilike $1 or location_text ilike $1 or resolution_notes ilike $1)
      order by created_at desc
      limit ${PER_SOURCE_LIMIT}`,
    [pattern],
  );
  return r.rows.map((i) => ({
    type: 'issue' as const,
    id: i.id,
    title: i.title?.trim() || 'תקלה',
    subtitle: i.location_text?.trim() ?? '',
    // Existing deep-link: /issues?issue=<id> opens (and fetches) the issue panel.
    href: `/issues?issue=${i.id}`,
  }));
}

interface DocumentRow {
  id: string;
  file_name: string | null;
  mime_type: string | null;
}
async function searchDocuments(pattern: string): Promise<SearchResult[]> {
  const r = await query<DocumentRow>(
    `select id, file_name, mime_type
       from public.documents
      where is_archived = false
        and file_name ilike $1
      order by created_at desc
      limit ${PER_SOURCE_LIMIT}`,
    [pattern],
  );
  return r.rows.map((d) => ({
    type: 'document' as const,
    id: d.id,
    title: d.file_name?.trim() || 'מסמך',
    subtitle: d.mime_type?.trim() ?? '',
    // The documents screen is a folder browser with no per-document deep-link.
    href: '/documents',
  }));
}

// GET /api/search?q=…  — returns SearchResult[] (flat, grouped client-side).
export async function GET(req: NextRequest) {
  const actor = await getCurrentActor();
  if (!actor) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const q = (req.nextUrl.searchParams.get('q') ?? '').trim();
  if (q.length < 2) {
    return NextResponse.json([]);
  }
  const pattern = likePattern(q);

  // Server-side RBAC: only query a source the actor may view. Debtors mirror the
  // /api/debtors guard — granted by `dashboard` (viewer) OR `contacts` (manager).
  const can = (module: string) => hasPermission(actor.role, actor.permissions, module, 'view');
  const tasks: Array<Promise<SearchResult[]>> = [];
  if (can('dashboard') || can('contacts')) tasks.push(searchDebtors(pattern));
  if (can('suppliers')) tasks.push(searchSuppliers(pattern));
  if (can('issues')) tasks.push(searchIssues(pattern));
  if (can('documents')) tasks.push(searchDocuments(pattern));

  // Each source is best-effort — one failing query never blanks the whole palette.
  const settled = await Promise.allSettled(tasks);
  const results: SearchResult[] = [];
  for (const s of settled) {
    if (s.status === 'fulfilled') results.push(...s.value);
    else console.error('[GET /api/search] source failed', s.reason);
  }

  return NextResponse.json(results);
}
