import 'server-only';
import { query, queryOne } from '@/lib/db';
import type {
  Supplier,
  SupplierListItem,
  SupplierListFilters,
  SupplierDocument,
  SupplierWritableFields,
} from '@/lib/types/suppliers';

const SUPPLIER_COLUMNS = `
  id, display_name, company_name, contact_person, supplier_type, status,
  phone, mobile, email, website, address, city, tax_id,
  bank_name, bank_branch, bank_account, payment_terms,
  notes, internal_notes, rating, created_by, created_by_name,
  created_at, updated_at, deleted_at`;

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
  if (filters.status && filters.status !== 'all') {
    params.push(filters.status);
    where.push(`s.status = $${params.length}`);
  }
  if (filters.type && filters.type !== 'all') {
    params.push(filters.type);
    where.push(`s.supplier_type = $${params.length}`);
  }

  const r = await query<SupplierListItem>(
    `select ${SUPPLIER_COLUMNS},
       (select count(*)::int from public.supplier_documents d where d.supplier_id = s.id) as documents_count
     from public.suppliers s
     where ${where.join(' and ')}
     order by case s.status when 'active' then 0 when 'inactive' then 1 else 2 end,
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
        notes, internal_notes, rating, created_by, created_by_name)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     returning id`,
    [
      fields.display_name, fields.company_name, fields.contact_person, fields.supplier_type,
      fields.status, fields.phone, fields.mobile, fields.email, fields.website, fields.address,
      fields.city, fields.tax_id, fields.bank_name, fields.bank_branch, fields.bank_account,
      fields.payment_terms, fields.notes, fields.internal_notes, fields.rating,
      createdBy, createdByName,
    ],
  );
  if (!row) throw new Error('failed_to_create_supplier');
  return row.id;
}

/** Whole-object update (the panel saves the full supplier in one PATCH). */
export async function updateSupplier(id: string, fields: SupplierWritableFields): Promise<boolean> {
  const r = await query(
    `update public.suppliers set
       display_name=$2, company_name=$3, contact_person=$4, supplier_type=$5, status=$6,
       phone=$7, mobile=$8, email=$9, website=$10, address=$11, city=$12, tax_id=$13,
       bank_name=$14, bank_branch=$15, bank_account=$16, payment_terms=$17,
       notes=$18, internal_notes=$19, rating=$20
     where id=$1 and deleted_at is null`,
    [
      id, fields.display_name, fields.company_name, fields.contact_person, fields.supplier_type,
      fields.status, fields.phone, fields.mobile, fields.email, fields.website, fields.address,
      fields.city, fields.tax_id, fields.bank_name, fields.bank_branch, fields.bank_account,
      fields.payment_terms, fields.notes, fields.internal_notes, fields.rating,
    ],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function softDeleteSupplier(id: string): Promise<boolean> {
  const r = await query(
    `update public.suppliers set deleted_at = now() where id = $1 and deleted_at is null`,
    [id],
  );
  return (r.rowCount ?? 0) > 0;
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
