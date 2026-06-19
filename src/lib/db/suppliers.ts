import 'server-only';
import { query, queryOne } from '@/lib/db';
import type {
  Supplier,
  SupplierListItem,
  SupplierListFilters,
  SupplierDocument,
  SupplierWritableFields,
  SupplierActivityEntry,
} from '@/lib/types/suppliers';

const SUPPLIER_COLUMNS = `
  id, display_name, company_name, contact_person, supplier_type, category_id, status,
  phone, mobile, email, website, address, city, tax_id,
  bank_name, bank_branch, bank_account, payment_terms,
  notes, internal_notes, rating, created_by, created_by_name,
  created_at, updated_at, deleted_at`;

// Same projection, prefixed for the list join (avoids ambiguity with
// supplier_categories columns of the same name).
const SUPPLIER_COLUMNS_S = `
  s.id, s.display_name, s.company_name, s.contact_person, s.supplier_type, s.category_id, s.status,
  s.phone, s.mobile, s.email, s.website, s.address, s.city, s.tax_id,
  s.bank_name, s.bank_branch, s.bank_account, s.payment_terms,
  s.notes, s.internal_notes, s.rating, s.created_by, s.created_by_name,
  s.created_at, s.updated_at, s.deleted_at`;

/** List active (non-deleted) suppliers with documents_count, filtered + sorted. */
export async function listSuppliers(filters: SupplierListFilters): Promise<SupplierListItem[]> {
  const where: string[] = ['s.deleted_at is null'];
  const params: unknown[] = [];

  if (filters.search && filters.search.trim()) {
    params.push(`%${filters.search.trim()}%`);
    const p = `$${params.length}`;
    where.push(
      `(s.display_name ilike ${p} or s.company_name ilike ${p} or s.contact_person ilike ${p}
        or s.phone ilike ${p} or s.mobile ilike ${p} or s.email ilike ${p})`,
    );
  }
  // Status tabs (exactly three): 'active' → only active; 'archived' → only
  // archived; 'all' / unset → both (no status predicate). Default on load is
  // 'active', sent explicitly by the client.
  if (filters.status === 'active' || filters.status === 'archived') {
    params.push(filters.status);
    where.push(`s.status = $${params.length}`);
  }
  if (filters.type && filters.type !== 'all') {
    params.push(filters.type);
    where.push(`s.supplier_type = $${params.length}`);
  }
  if (filters.category && filters.category !== 'all') {
    params.push(filters.category);
    where.push(`s.category_id = $${params.length}`);
  }

  const r = await query<SupplierListItem>(
    `select ${SUPPLIER_COLUMNS_S},
       c.name as category_name,
       (select count(*)::int from public.supplier_documents d where d.supplier_id = s.id) as documents_count
     from public.suppliers s
     left join public.supplier_categories c on c.id = s.category_id
     where ${where.join(' and ')}
     order by case s.status when 'active' then 0 else 1 end,
              s.display_name asc`,
    params,
  );
  return r.rows;
}

export async function getSupplierById(id: string): Promise<Supplier | null> {
  return queryOne<Supplier>(
    `select ${SUPPLIER_COLUMNS} from public.suppliers where id = $1 and deleted_at is null`,
    [id],
  );
}

export async function createSupplier(
  fields: SupplierWritableFields,
  createdBy: string,
  createdByName: string,
): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `insert into public.suppliers
       (display_name, company_name, contact_person, supplier_type, status,
        phone, mobile, email, website, address, city, tax_id,
        bank_name, bank_branch, bank_account, payment_terms,
        notes, internal_notes, rating, created_by, created_by_name, category_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     returning id`,
    [
      fields.display_name, fields.company_name, fields.contact_person, fields.supplier_type,
      fields.status, fields.phone, fields.mobile, fields.email, fields.website, fields.address,
      fields.city, fields.tax_id, fields.bank_name, fields.bank_branch, fields.bank_account,
      fields.payment_terms, fields.notes, fields.internal_notes, fields.rating,
      createdBy, createdByName, fields.category_id,
    ],
  );
  if (!row) throw new Error('failed_to_create_supplier');
  return row.id;
}

/** Whole-object update (the panel saves the full supplier in one PATCH).
 *  Returns the updated row (for the activity diff + live UI) or null if the
 *  supplier does not exist / is soft-deleted. */
export async function updateSupplier(
  id: string,
  fields: SupplierWritableFields,
): Promise<Supplier | null> {
  return queryOne<Supplier>(
    `update public.suppliers set
       display_name=$2, company_name=$3, contact_person=$4, supplier_type=$5, status=$6,
       phone=$7, mobile=$8, email=$9, website=$10, address=$11, city=$12, tax_id=$13,
       bank_name=$14, bank_branch=$15, bank_account=$16, payment_terms=$17,
       notes=$18, internal_notes=$19, rating=$20, category_id=$21
     where id=$1 and deleted_at is null
     returning ${SUPPLIER_COLUMNS}`,
    [
      id, fields.display_name, fields.company_name, fields.contact_person, fields.supplier_type,
      fields.status, fields.phone, fields.mobile, fields.email, fields.website, fields.address,
      fields.city, fields.tax_id, fields.bank_name, fields.bank_branch, fields.bank_account,
      fields.payment_terms, fields.notes, fields.internal_notes, fields.rating, fields.category_id,
    ],
  );
}

export async function softDeleteSupplier(id: string): Promise<boolean> {
  const r = await query(
    `update public.suppliers set deleted_at = now() where id = $1 and deleted_at is null`,
    [id],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Contact details for an active supplier — used by the create-form notification
 *  matrix to email/WhatsApp a supplier assignee. phone prefers mobile (for
 *  WhatsApp), falling back to the landline. Null when missing/soft-deleted. */
export interface SupplierNotifyContact {
  display_name: string;
  email: string | null;
  phone: string | null;
}

export async function getSupplierNotifyContact(id: string): Promise<SupplierNotifyContact | null> {
  return queryOne<SupplierNotifyContact>(
    `select display_name,
            nullif(email, '')  as email,
            coalesce(nullif(mobile, ''), nullif(phone, '')) as phone
       from public.suppliers
      where id = $1 and deleted_at is null`,
    [id],
  );
}

/** True when a supplier exists and is not soft-deleted — the guard for linking a
 *  supplier to another entity (e.g. an issue's supplier_id). */
export async function supplierExists(id: string): Promise<boolean> {
  const row = await queryOne<{ ok: boolean }>(
    `select true as ok from public.suppliers where id = $1 and deleted_at is null limit 1`,
    [id],
  );
  return row?.ok ?? false;
}

// ── Documents ─────────────────────────────────────────────────────────────
export async function listSupplierDocuments(supplierId: string): Promise<SupplierDocument[]> {
  const r = await query<SupplierDocument>(
    `select id, supplier_id, file_name, file_url, file_size_bytes, mime_type, doc_type,
            uploaded_by, uploaded_by_name, created_at
       from public.supplier_documents
       where supplier_id = $1
       order by created_at desc`,
    [supplierId],
  );
  return r.rows;
}

export async function insertSupplierDocument(input: {
  supplierId: string;
  fileName: string;
  fileUrl: string;
  fileSizeBytes: number;
  mimeType: string;
  docType: string;
  uploadedBy: string;
  uploadedByName: string;
}): Promise<SupplierDocument> {
  const row = await queryOne<SupplierDocument>(
    `insert into public.supplier_documents
       (supplier_id, file_name, file_url, file_size_bytes, mime_type, doc_type, uploaded_by, uploaded_by_name)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     returning id, supplier_id, file_name, file_url, file_size_bytes, mime_type, doc_type,
               uploaded_by, uploaded_by_name, created_at`,
    [
      input.supplierId, input.fileName, input.fileUrl, input.fileSizeBytes,
      input.mimeType, input.docType, input.uploadedBy, input.uploadedByName,
    ],
  );
  if (!row) throw new Error('failed_to_insert_document');
  return row;
}

export async function getSupplierDocument(docId: string): Promise<SupplierDocument | null> {
  return queryOne<SupplierDocument>(
    `select id, supplier_id, file_name, file_url, file_size_bytes, mime_type, doc_type,
            uploaded_by, uploaded_by_name, created_at
       from public.supplier_documents where id = $1`,
    [docId],
  );
}

export async function deleteSupplierDocumentRow(docId: string): Promise<boolean> {
  const r = await query(`delete from public.supplier_documents where id = $1`, [docId]);
  return (r.rowCount ?? 0) > 0;
}

/** Rename a document's display name (file_name) only — the stored object path
 *  (file_url, a UUID) is immutable, so the bytes are untouched. */
export async function renameSupplierDocument(
  docId: string,
  fileName: string,
): Promise<SupplierDocument | null> {
  return queryOne<SupplierDocument>(
    `update public.supplier_documents set file_name = $2
       where id = $1
       returning id, supplier_id, file_name, file_url, file_size_bytes, mime_type, doc_type,
                 uploaded_by, uploaded_by_name, created_at`,
    [docId, fileName],
  );
}

// ── Activity (central audit_log, entity_type='supplier') ────────────────────
export async function listSupplierActivity(
  supplierId: string,
): Promise<SupplierActivityEntry[]> {
  const r = await query<SupplierActivityEntry>(
    `select a.id, a.action, a.changes, a.metadata,
            coalesce(u.full_name, u.username) as actor_name,
            a.created_at
       from public.audit_log a
       left join public.users u on u.id = a.actor_user_id
      where a.entity_type = 'supplier' and a.entity_id = $1
      order by a.created_at desc`,
    [supplierId],
  );
  return r.rows;
}
