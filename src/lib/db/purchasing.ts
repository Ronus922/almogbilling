import 'server-only';
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, queryOne, withTransaction } from '@/lib/db';
import {
  DEFAULT_VAT_RATE, EMPTY_COMPANY, partyKey, quoteTotal,
  type CompanySettings, type DocType,
} from '@/lib/purchasing/model';

// Purchasing ("רכש") persistence — requests for quotation and purchase orders.
// Money columns are NUMERIC; every select casts them ::float8 (the values are
// 2-decimal ILS amounts, far inside float range) so the rest of the app never
// sees a pg string.

const COMPANY_KEY = 'purchasing_company';

// ── Letterhead (app_settings) ───────────────────────────────────────────────

export async function getCompany(): Promise<CompanySettings | null> {
  const row = await queryOne<{ value: Partial<CompanySettings> }>(
    `select value from public.app_settings where key = $1 limit 1`,
    [COMPANY_KEY],
  );
  if (!row) return null;
  return { ...EMPTY_COMPANY, ...row.value, vat_rate: Number(row.value.vat_rate ?? DEFAULT_VAT_RATE) };
}

export async function saveCompany(value: CompanySettings, userId: string): Promise<void> {
  await query(
    `insert into public.app_settings (key, value, updated_by, updated_at)
     values ($1, $2::jsonb, $3, now())
     on conflict (key) do update
       set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
    [COMPANY_KEY, JSON.stringify(value), userId],
  );
}

// ── Numbering ───────────────────────────────────────────────────────────────

export class StartNumberRequiredError extends Error {
  constructor() {
    super('start_number_required');
    this.name = 'StartNumberRequiredError';
  }
}

/** The last issued number of each series, null while a series has none (the
 *  screen then asks "from which number to start"). */
export async function getSequenceState(): Promise<Record<DocType, number | null>> {
  const r = await query<{ doc_type: DocType; last_number: number }>(
    `select doc_type, last_number from public.purchasing_sequences`,
  );
  const out: Record<DocType, number | null> = { rfq: null, po: null };
  for (const row of r.rows) out[row.doc_type] = row.last_number;
  return out;
}

/** Atomic next number of a series, inside the caller's transaction. The first
 *  document of a series takes `start`; afterwards it is last_number + 1 under a
 *  row lock, so two parallel saves can never receive the same number. */
async function allocateNumber(client: PoolClient, type: DocType, start: number | null): Promise<number> {
  let r = await client.query<{ last_number: number }>(
    `select last_number from public.purchasing_sequences where doc_type = $1 for update`,
    [type],
  );
  if (r.rowCount === 0) {
    if (start === null) throw new StartNumberRequiredError();
    const ins = await client.query(
      `insert into public.purchasing_sequences (doc_type, last_number) values ($1, $2)
       on conflict (doc_type) do nothing returning last_number`,
      [type, start],
    );
    if (ins.rowCount === 1) return start;
    // Another save created the series between our select and insert.
    r = await client.query<{ last_number: number }>(
      `select last_number from public.purchasing_sequences where doc_type = $1 for update`,
      [type],
    );
  }
  const next = r.rows[0].last_number + 1;
  await client.query(
    `update public.purchasing_sequences set last_number = $2, updated_at = now() where doc_type = $1`,
    [type, next],
  );
  return next;
}

// ── Suppliers (read-only) ───────────────────────────────────────────────────

export interface SupplierBrief {
  id: string;
  name: string;
  email: string;
  phone: string;
  mobile: string;
  address: string;
  tax_id: string;
}

const SUPPLIER_COLS = `
  s.id,
  coalesce(nullif(s.company_name, ''), s.display_name) as name,
  s.email, s.phone, s.mobile,
  nullif(concat_ws(', ', nullif(s.address, ''), nullif(s.city, '')), '') as address,
  s.tax_id`;

export async function getSupplierBrief(id: string): Promise<SupplierBrief | null> {
  const r = await queryOne<SupplierBrief>(
    `select ${SUPPLIER_COLS} from public.suppliers s where s.id = $1 and s.deleted_at is null`,
    [id],
  );
  return r ? { ...r, address: r.address ?? '' } : null;
}

export async function listSupplierBriefs(ids: string[]): Promise<SupplierBrief[]> {
  if (ids.length === 0) return [];
  const r = await query<SupplierBrief>(
    `select ${SUPPLIER_COLS} from public.suppliers s where s.id = any($1::uuid[]) and s.deleted_at is null`,
    [ids],
  );
  return r.rows.map((x) => ({ ...x, address: x.address ?? '' }));
}

/** Active suppliers for the recipient / PO supplier pickers. */
export async function listPickableSuppliers(): Promise<SupplierBrief[]> {
  const r = await query<SupplierBrief>(
    `select ${SUPPLIER_COLS} from public.suppliers s
      where s.deleted_at is null and s.status = 'active'
      order by 2`,
  );
  return r.rows.map((x) => ({ ...x, address: x.address ?? '' }));
}

// ── Documents ───────────────────────────────────────────────────────────────

export interface LineRow {
  id: string;
  sort_order: number;
  description: string;
  quantity: number;
  unit_price: number | null;
}

export interface FileRow {
  id: string;
  document_id: string | null;
  quote_id: string | null;
  object_key: string;
  original_filename: string;
  mime_type: string;
  file_size: number;
  uploaded_via: 'staff' | 'supplier';
  created_at: string;
}

export interface DocumentRow {
  id: string;
  doc_type: DocType;
  /** null while it is a draft — the number is allocated when it is issued. */
  number: number | null;
  status: 'draft' | 'issued';
  doc_date: string;
  title: string;
  supplier_id: string | null;
  /** The list supplier's name, or the one typed by hand. */
  supplier_name: string | null;
  /** Hand-typed supplier details (supplier_id null); kept on the document only. */
  supplier_phone: string | null;
  supplier_email: string | null;
  supplier_address: string | null;
  notes: string;
  due_date: string | null;
  /** A request's "send by" ticks on its form (kept on a draft; the send happens on issue). */
  send_email: boolean;
  send_whatsapp: boolean;
  vat_rate: number;
  source_rfq_id: string | null;
  source_rfq_number: number | null;
  winner_supplier_id: string | null;
  /** The winner is the document's hand-typed supplier (no supplier_id). */
  winner_manual: boolean;
  /** The winner's key when it is a hand-typed supplier of the request. */
  winner_manual_key: string | null;
  winner_supplier_name: string | null;
  winner_chosen_at: string | null;
  winner_chosen_by_name: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const DOC_COLS = `
  d.id, d.doc_type, d.number, d.status, d.doc_date::text as doc_date, coalesce(d.title, '') as title, d.supplier_id,
  coalesce(nullif(sp.company_name, ''), sp.display_name, nullif(d.supplier_name, '')) as supplier_name,
  d.supplier_phone, d.supplier_email, d.supplier_address,
  d.notes, d.due_date::text as due_date, d.send_email, d.send_whatsapp, d.vat_rate::float8 as vat_rate,
  d.source_rfq_id, src.number as source_rfq_number,
  d.winner_supplier_id,
  (d.winner_chosen_at is not null and d.winner_supplier_id is null) as winner_manual,
  d.winner_manual_key,
  coalesce(
    nullif(ws.company_name, ''), ws.display_name,
    case when d.winner_chosen_at is not null and d.winner_supplier_id is null then
      coalesce(
        (select nullif(wq.supplier_name, '') from public.purchasing_quotes wq
          where wq.rfq_id = d.id and wq.manual_key = d.winner_manual_key limit 1),
        nullif(d.supplier_name, ''))
    end
  ) as winner_supplier_name,
  d.winner_chosen_at,
  wu.full_name as winner_chosen_by_name,
  d.created_by, d.created_at, d.updated_at`;

const DOC_JOINS = `
  from public.purchasing_documents d
  left join public.suppliers sp on sp.id = d.supplier_id
  left join public.suppliers ws on ws.id = d.winner_supplier_id
  left join public.users wu on wu.id = d.winner_chosen_by
  left join public.purchasing_documents src on src.id = d.source_rfq_id`;

export interface DocumentListItem extends DocumentRow {
  line_count: number;
  subtotal: number;
  recipient_count: number;
  quote_count: number;
  /** Portal quotes that arrived (or were amended) after the request was last opened. */
  unseen_quote_count: number;
}

/** A portal quote is "new" while it is later than the request's `quotes_seen_at`
 *  stamp. Staff-entered (`manual`) quotes never count: they are not news to
 *  whoever typed them. */
const UNSEEN_QUOTES_SQL = `
  select count(*)::int from public.purchasing_quotes q
   where q.rfq_id = d.id and q.source = 'portal'
     and greatest(q.submitted_at, q.updated_at) > coalesce(d.quotes_seen_at, '-infinity'::timestamptz)`;

export async function listDocuments(type: DocType): Promise<DocumentListItem[]> {
  const r = await query<DocumentListItem>(
    `select ${DOC_COLS},
       (select count(*)::int from public.purchasing_lines l where l.document_id = d.id) as line_count,
       coalesce((select sum(round(l.quantity * coalesce(l.unit_price, 0), 2))
                   from public.purchasing_lines l where l.document_id = d.id), 0)::float8 as subtotal,
       (select count(*)::int from public.purchasing_rfq_recipients rr where rr.rfq_id = d.id) as recipient_count,
       (select count(*)::int from public.purchasing_quotes q where q.rfq_id = d.id) as quote_count,
       (${UNSEEN_QUOTES_SQL}) as unseen_quote_count
     ${DOC_JOINS}
     where d.doc_type = $1 and d.deleted_at is null
     order by (d.status = 'draft') desc, d.doc_date desc, d.number desc nulls first, d.created_at desc`,
    [type],
  );
  return r.rows;
}

export async function findDocument(id: string): Promise<DocumentRow | null> {
  return queryOne<DocumentRow>(
    `select ${DOC_COLS} ${DOC_JOINS} where d.id = $1 and d.deleted_at is null`,
    [id],
  );
}

export async function listLines(documentId: string): Promise<LineRow[]> {
  const r = await query<LineRow>(
    `select id, sort_order, description, quantity::float8 as quantity, unit_price::float8 as unit_price
       from public.purchasing_lines where document_id = $1 order by sort_order`,
    [documentId],
  );
  return r.rows;
}

export async function listDocumentFiles(documentId: string): Promise<FileRow[]> {
  const r = await query<FileRow>(
    `select id, document_id, quote_id, object_key, original_filename, mime_type,
            file_size::int as file_size, uploaded_via, created_at
       from public.purchasing_files where document_id = $1 order by created_at`,
    [documentId],
  );
  return r.rows;
}

export interface LineInput {
  description: string;
  quantity: number;
  unit_price: number | null;
}

async function insertLines(client: PoolClient, documentId: string, lines: readonly LineInput[]): Promise<void> {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    await client.query(
      `insert into public.purchasing_lines (document_id, sort_order, description, quantity, unit_price)
       values ($1, $2, $3, $4, $5)`,
      [documentId, i + 1, l.description, l.quantity, l.unit_price],
    );
  }
}

/** The document's supplier: a list supplier (id) or one typed by hand. */
export interface SupplierFields {
  supplier_id: string | null;
  supplier_name: string | null;
  supplier_phone: string | null;
  supplier_email: string | null;
  supplier_address: string | null;
}

/** One supplier of a request, as the form sends it. */
export interface RecipientInput {
  /** A listed supplier, or null for a hand-typed one (then `key` identifies it). */
  supplier_id: string | null;
  key: string | null;
  name: string | null;
  phone: string | null;
  email: string | null;
}

export interface CreateDocumentInput extends SupplierFields {
  doc_type: DocType;
  /** A draft takes no number; an issued document allocates the next one. */
  status: 'draft' | 'issued';
  doc_date: string;
  title: string;
  notes: string;
  due_date: string | null;
  vat_rate: number;
  source_rfq_id: string | null;
  start_number: number | null;
  lines: LineInput[];
  /** A request's suppliers and "send by" ticks. */
  recipients?: RecipientInput[];
  send_email?: boolean;
  send_whatsapp?: boolean;
}

/** Makes the recipients of a request exactly `parties`: new ones get their
 *  personal token, hand-typed ones keep it while their details are refreshed,
 *  the ones left out are removed. Only for a draft / the moment of issue — an
 *  issued request's suppliers (and the quotes behind them) are not edited. */
async function syncRecipients(client: PoolClient, rfqId: string, parties: readonly RecipientInput[]): Promise<void> {
  const keep = parties.map((p) => p.supplier_id ?? p.key);
  await client.query(
    `delete from public.purchasing_rfq_recipients rr
      where rr.rfq_id = $1 and coalesce(rr.supplier_id::text, rr.manual_key) <> all($2::text[])`,
    [rfqId, keep],
  );
  for (const p of parties) {
    const token = randomBytes(32).toString('base64url');
    if (p.supplier_id) {
      await client.query(
        `insert into public.purchasing_rfq_recipients (rfq_id, supplier_id, token)
         values ($1, $2, $3) on conflict (rfq_id, supplier_id) do nothing`,
        [rfqId, p.supplier_id, token],
      );
    } else {
      await client.query(
        `insert into public.purchasing_rfq_recipients
           (rfq_id, supplier_id, manual_key, token, supplier_name, supplier_phone, supplier_email)
         values ($1, null, $2, $3, $4, $5, $6)
         on conflict (rfq_id, manual_key) where manual_key is not null do update
           set supplier_name = excluded.supplier_name, supplier_phone = excluded.supplier_phone,
               supplier_email = excluded.supplier_email`,
        [rfqId, p.key, token, p.name, p.phone, p.email],
      );
    }
  }
}

/** Issues a document: allocates its number, writes it and its lines in ONE
 *  transaction, so a failure never burns a number or leaves a headless line. */
export async function createDocument(
  input: CreateDocumentInput,
  actorId: string,
): Promise<{ id: string; number: number | null }> {
  return withTransaction(async (client) => {
    const number = input.status === 'issued' ? await allocateNumber(client, input.doc_type, input.start_number) : null;
    const ins = await client.query<{ id: string }>(
      `insert into public.purchasing_documents
         (doc_type, number, status, doc_date, title, supplier_id, supplier_name, supplier_phone, supplier_email,
          supplier_address, notes, due_date, vat_rate, source_rfq_id, created_by, send_email, send_whatsapp)
       values ($1, $2, $15, $3, nullif($4, ''), $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $16, $17) returning id`,
      [
        input.doc_type, number, input.doc_date, input.title, input.supplier_id, input.supplier_name,
        input.supplier_phone, input.supplier_email, input.supplier_address, input.notes,
        input.due_date, input.vat_rate, input.source_rfq_id, actorId, input.status,
        input.send_email ?? false, input.send_whatsapp ?? false,
      ],
    );
    const id = ins.rows[0].id;
    await insertLines(client, id, input.lines);
    if (input.recipients) await syncRecipients(client, id, input.recipients);
    return { id, number };
  });
}

export interface UpdateDocumentInput extends SupplierFields {
  doc_date: string;
  title: string;
  notes: string;
  due_date: string | null;
  /** undefined = leave the lines alone (an RFQ whose lines are locked). */
  lines?: LineInput[];
  /** undefined = leave the suppliers / ticks alone (editing an issued request). */
  recipients?: RecipientInput[];
  send_email?: boolean;
  send_whatsapp?: boolean;
  /** Turns a DRAFT into an issued document: allocates its number and stamps the
   *  company VAT rate, in the same transaction as the update. */
  issue?: { start_number: number | null; vat_rate: number };
}

export class NotADraftError extends Error {
  constructor() {
    super('not_a_draft');
    this.name = 'NotADraftError';
  }
}

/** Updates a document; returns its number afterwards, or null when it does not
 *  exist. `issue` on a non-draft throws NotADraftError (nothing is written). */
export async function updateDocument(id: string, input: UpdateDocumentInput): Promise<{ number: number | null } | null> {
  return withTransaction(async (client) => {
    const cur = await client.query<{ doc_type: DocType; number: number | null; status: 'draft' | 'issued' }>(
      `select doc_type, number, status from public.purchasing_documents where id = $1 and deleted_at is null for update`,
      [id],
    );
    if (cur.rowCount === 0) return null;
    let { number, status } = cur.rows[0];
    let vat: number | null = null;
    if (input.issue) {
      if (status !== 'draft') throw new NotADraftError();
      number = await allocateNumber(client, cur.rows[0].doc_type, input.issue.start_number);
      status = 'issued';
      vat = input.issue.vat_rate;
    }
    await client.query(
      `update public.purchasing_documents
          set doc_date = $2, title = nullif($3, ''), supplier_id = $4, supplier_name = $5, supplier_phone = $6,
              supplier_email = $7, supplier_address = $8, notes = $9,
              due_date = coalesce($10, due_date), number = $11, status = $12,
              vat_rate = coalesce($13::numeric, vat_rate),
              send_email = coalesce($14::boolean, send_email), send_whatsapp = coalesce($15::boolean, send_whatsapp),
              updated_at = now()
        where id = $1 and deleted_at is null`,
      [
        id, input.doc_date, input.title, input.supplier_id, input.supplier_name, input.supplier_phone,
        input.supplier_email, input.supplier_address, input.notes, input.due_date, number, status, vat,
        input.send_email ?? null, input.send_whatsapp ?? null,
      ],
    );
    if (input.recipients) {
      if (status !== 'draft' && !input.issue) throw new Error('recipients are only synced on a draft or at issue');
      await syncRecipients(client, id, input.recipients);
    }
    if (input.lines) {
      await client.query(`delete from public.purchasing_lines where document_id = $1`, [id]);
      await insertLines(client, id, input.lines);
    }
    return { number };
  });
}

/** Removes a DRAFT for good (it never had a number, so nothing is reissued or
 *  left behind). False when the id is not a live draft. */
export async function deleteDraft(id: string): Promise<boolean> {
  const r = await query(
    `delete from public.purchasing_documents where id = $1 and status = 'draft' and deleted_at is null`,
    [id],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Soft delete: the number stays used (never reissued), the row stays for audit. */
export async function softDeleteDocument(id: string): Promise<boolean> {
  const r = await query(
    `update public.purchasing_documents set deleted_at = now(), updated_at = now()
      where id = $1 and deleted_at is null and status = 'issued'`,
    [id],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Opening a request counts as seeing its quotes: stamps the document. Only
 *  touches a request that actually has something new, so a plain re-open does
 *  not rewrite the row. */
export async function markQuotesSeen(rfqId: string): Promise<void> {
  await query(
    `update public.purchasing_documents d set quotes_seen_at = now()
      where d.id = $1 and d.doc_type = 'rfq' and d.deleted_at is null
        and (${UNSEEN_QUOTES_SQL}) > 0`,
    [rfqId],
  );
}

/** The number on the menu: requests that hold at least one new portal quote. */
export async function countRfqsWithUnseenQuotes(): Promise<number> {
  const r = await queryOne<{ n: number }>(
    `select count(*)::int as n from public.purchasing_documents d
      where d.doc_type = 'rfq' and d.status = 'issued' and d.deleted_at is null
        and (${UNSEEN_QUOTES_SQL}) > 0`,
  );
  return r?.n ?? 0;
}

export interface RfqAnswerStats {
  recipients: number;
  /** Recipients that have a quote on the request. */
  answered: number;
}

export async function getRfqAnswerStats(rfqId: string): Promise<RfqAnswerStats> {
  const r = await queryOne<RfqAnswerStats>(
    `select count(*)::int as recipients,
            (count(*) filter (where exists (
               select 1 from public.purchasing_quotes q
                where q.rfq_id = rr.rfq_id and q.supplier_id is not distinct from rr.supplier_id
                 and q.manual_key is not distinct from rr.manual_key)))::int as answered
       from public.purchasing_rfq_recipients rr where rr.rfq_id = $1`,
    [rfqId],
  );
  return r ?? { recipients: 0, answered: 0 };
}

export interface RfqNoticeRow { id: string; number: number; title: string; created_by: string | null }

/** Claims, once, the requests whose due date has passed (Israel date `today`)
 *  and that were sent to at least one supplier: the stamp is written in the same
 *  statement that returns them, so two overlapping runs can never both notify. */
export async function claimDueNotices(today: string): Promise<RfqNoticeRow[]> {
  const r = await query<RfqNoticeRow>(
    `update public.purchasing_documents d set due_notice_sent_at = now()
      where d.doc_type = 'rfq' and d.status = 'issued' and d.deleted_at is null
        and d.due_notice_sent_at is null and d.due_date < $1::date
        and exists (select 1 from public.purchasing_rfq_recipients rr where rr.rfq_id = d.id)
      returning d.id, d.number, coalesce(d.title, '') as title, d.created_by`,
    [today],
  );
  return r.rows;
}

/** Previously entered descriptions, most used first — the "פירוט" autocomplete. */
export async function suggestDescriptions(q: string, limit = 8): Promise<string[]> {
  const needle = q.trim();
  const r = await query<{ description: string }>(
    `select l.description
       from public.purchasing_lines l
       join public.purchasing_documents d on d.id = l.document_id and d.deleted_at is null
      where $1 = '' or l.description ilike '%' || replace(replace($1, '%', ''), '_', '') || '%'
      group by l.description
      order by count(*) desc, max(d.created_at) desc
      limit $2`,
    [needle, limit],
  );
  return r.rows.map((x) => x.description);
}

/** A request's lines are locked once suppliers may have priced them: something
 *  was sent to a supplier, or a quote exists. */
export async function isRfqLocked(rfqId: string): Promise<boolean> {
  const r = await queryOne<{ locked: boolean }>(
    `select (exists (select 1 from public.purchasing_dispatches x where x.document_id = $1 and x.status = 'sent')
          or exists (select 1 from public.purchasing_quotes q where q.rfq_id = $1)) as locked`,
    [rfqId],
  );
  return r?.locked ?? false;
}

// ── Recipients of a request (the personal links) ────────────────────────────

export interface RecipientRow {
  id: string;
  rfq_id: string;
  /** null = the document's hand-typed supplier. */
  supplier_id: string | null;
  supplier_name: string;
  /** The hand-typed supplier's key (supplier_id null), else null. */
  manual_key: string | null;
  /** A hand-typed supplier's own details (a listed one's are read from `suppliers`). */
  supplier_phone: string | null;
  supplier_email: string | null;
  token: string;
  created_at: string;
  /** When the request was first sent to it (a successful dispatch), else null. */
  sent_at: string | null;
  first_viewed_at: string | null;
  last_viewed_at: string | null;
}

/** A hand-typed supplier's details, copied onto its recipient / quote rows. */
export interface ManualParty {
  /** Identifies it within the request. */
  key: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
}

const REC_COLS = `
  rr.id, rr.rfq_id, rr.supplier_id,
  coalesce(nullif(s.company_name, ''), s.display_name, nullif(rr.supplier_name, '')) as supplier_name,
  rr.manual_key, rr.supplier_phone, rr.supplier_email,
  rr.token, rr.created_at,
  (select min(x.sent_at) from public.purchasing_dispatches x
    where x.document_id = rr.rfq_id and x.status = 'sent'
      and x.supplier_id is not distinct from rr.supplier_id
      and x.manual_key is not distinct from rr.manual_key) as sent_at,
  rr.first_viewed_at, rr.last_viewed_at`;

export async function listRecipients(rfqId: string): Promise<RecipientRow[]> {
  const r = await query<RecipientRow>(
    `select ${REC_COLS} from public.purchasing_rfq_recipients rr
       left join public.suppliers s on s.id = rr.supplier_id
      where rr.rfq_id = $1 order by rr.created_at`,
    [rfqId],
  );
  return r.rows;
}

/** One link per (request, supplier): asking again returns the same token, so a
 *  reminder never breaks the link the supplier already has. `supplierId` null is
 *  a hand-typed supplier (`manual` carries its key and details; its details are
 *  refreshed, the token stays). */
export async function ensureRecipient(
  rfqId: string, supplierId: string | null, manual: ManualParty | null = null,
): Promise<RecipientRow> {
  const token = randomBytes(32).toString('base64url');
  if (supplierId) {
    await query(
      `insert into public.purchasing_rfq_recipients (rfq_id, supplier_id, token)
       values ($1, $2, $3) on conflict (rfq_id, supplier_id) do nothing`,
      [rfqId, supplierId, token],
    );
  } else {
    if (!manual) throw new Error('manual party details are required');
    await query(
      `insert into public.purchasing_rfq_recipients
         (rfq_id, supplier_id, manual_key, token, supplier_name, supplier_phone, supplier_email, supplier_address)
       values ($1, null, $2, $3, $4, $5, $6, $7)
       on conflict (rfq_id, manual_key) where manual_key is not null do update
         set supplier_name = excluded.supplier_name, supplier_phone = excluded.supplier_phone,
             supplier_email = excluded.supplier_email, supplier_address = excluded.supplier_address`,
      [rfqId, manual.key, token, manual.name, manual.phone, manual.email, manual.address],
    );
  }
  const r = await queryOne<RecipientRow>(
    `select ${REC_COLS} from public.purchasing_rfq_recipients rr
       left join public.suppliers s on s.id = rr.supplier_id
      where rr.rfq_id = $1 and rr.supplier_id is not distinct from $2::uuid
        and rr.manual_key is not distinct from $3::text`,
    [rfqId, supplierId, manual?.key ?? null],
  );
  return r as RecipientRow;
}

export interface PublicQuoteContext {
  recipient: { id: string; rfq_id: string; supplier_id: string | null; supplier_name: string; party: ManualParty | null };
  rfq: {
    id: string; number: number; title: string; doc_date: string; due_date: string;
    notes: string; vat_rate: number;
  };
  lines: Array<{ id: string; sort_order: number; description: string; quantity: number }>;
  quote: QuoteRow | null;
  /** The request's own attachments (staff-side), for the supplier to download. */
  rfq_files: FileRow[];
}

/** Everything the supplier's public page may show, resolved from the token
 *  ALONE — nothing here is reachable with another request's or supplier's id.
 *  Null for an unknown token or a deleted request. */
export async function findPublicContext(token: string): Promise<PublicQuoteContext | null> {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) return null;
  const rec = await queryOne<{
    id: string; rfq_id: string; supplier_id: string | null; manual_key: string | null; supplier_name: string;
    supplier_phone: string | null; supplier_email: string | null; supplier_address: string | null;
    number: number; title: string; doc_date: string; due_date: string; notes: string; vat_rate: number;
  }>(
    `select rr.id, rr.rfq_id, rr.supplier_id, rr.manual_key,
            coalesce(nullif(s.company_name, ''), s.display_name, nullif(rr.supplier_name, '')) as supplier_name,
            rr.supplier_phone, rr.supplier_email, rr.supplier_address,
            d.number, coalesce(d.title, '') as title, d.doc_date::text as doc_date, d.due_date::text as due_date,
            d.notes, d.vat_rate::float8 as vat_rate
       from public.purchasing_rfq_recipients rr
       join public.purchasing_documents d on d.id = rr.rfq_id and d.deleted_at is null and d.doc_type = 'rfq'
                                          and d.status = 'issued'
       left join public.suppliers s on s.id = rr.supplier_id
      where rr.token = $1`,
    [token],
  );
  if (!rec) return null;
  const lines = (await listLines(rec.rfq_id)).map((l) => ({
    id: l.id, sort_order: l.sort_order, description: l.description, quantity: l.quantity,
  }));
  const quote = await findQuote(rec.rfq_id, rec.supplier_id ?? rec.manual_key ?? '');
  return {
    recipient: {
      id: rec.id, rfq_id: rec.rfq_id, supplier_id: rec.supplier_id, supplier_name: rec.supplier_name,
      party: rec.supplier_id || !rec.manual_key
        ? null
        : { key: rec.manual_key, name: rec.supplier_name, phone: rec.supplier_phone, email: rec.supplier_email, address: rec.supplier_address },
    },
    rfq: {
      id: rec.rfq_id, number: rec.number, title: rec.title, doc_date: rec.doc_date,
      due_date: rec.due_date, notes: rec.notes, vat_rate: rec.vat_rate,
    },
    lines,
    quote,
    rfq_files: await listDocumentFiles(rec.rfq_id),
  };
}

export async function markRecipientViewed(recipientId: string): Promise<void> {
  await query(
    `update public.purchasing_rfq_recipients
        set first_viewed_at = coalesce(first_viewed_at, now()), last_viewed_at = now()
      where id = $1`,
    [recipientId],
  );
}

// ── Quotes ──────────────────────────────────────────────────────────────────

export interface QuoteRow {
  id: string;
  rfq_id: string;
  /** null = a hand-typed supplier of the request (then `manual_key`). */
  supplier_id: string | null;
  manual_key: string | null;
  supplier_name: string;
  /** A hand-typed supplier's own details. */
  supplier_phone: string | null;
  supplier_email: string | null;
  supplier_address: string | null;
  source: 'portal' | 'manual';
  total_amount: number | null;
  valid_until: string | null;
  notes: string;
  submitted_at: string;
  updated_at: string;
  /** line id → unit price. */
  prices: Record<string, number>;
  files: FileRow[];
}

type QuoteBase = Omit<QuoteRow, 'prices' | 'files'>;

const QUOTE_COLS = `
  q.id, q.rfq_id, q.supplier_id, q.manual_key,
  coalesce(nullif(s.company_name, ''), s.display_name, nullif(q.supplier_name, '')) as supplier_name,
  q.supplier_phone, q.supplier_email, q.supplier_address,
  q.source, q.total_amount::float8 as total_amount, q.valid_until::text as valid_until,
  q.notes, q.submitted_at, q.updated_at`;

async function hydrateQuotes(bases: QuoteBase[]): Promise<QuoteRow[]> {
  if (bases.length === 0) return [];
  const ids = bases.map((b) => b.id);
  const prices = await query<{ quote_id: string; line_id: string; unit_price: number }>(
    `select quote_id, line_id, unit_price::float8 as unit_price
       from public.purchasing_quote_lines where quote_id = any($1::uuid[])`,
    [ids],
  );
  const files = await query<FileRow>(
    `select id, document_id, quote_id, object_key, original_filename, mime_type,
            file_size::int as file_size, uploaded_via, created_at
       from public.purchasing_files where quote_id = any($1::uuid[]) order by created_at`,
    [ids],
  );
  return bases.map((b) => ({
    ...b,
    prices: Object.fromEntries(prices.rows.filter((p) => p.quote_id === b.id).map((p) => [p.line_id, p.unit_price])),
    files: files.rows.filter((f) => f.quote_id === b.id),
  }));
}

export async function listQuotes(rfqId: string): Promise<QuoteRow[]> {
  const r = await query<QuoteBase>(
    `select ${QUOTE_COLS} from public.purchasing_quotes q
       left join public.suppliers s on s.id = q.supplier_id
      where q.rfq_id = $1 order by q.submitted_at`,
    [rfqId],
  );
  return hydrateQuotes(r.rows);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `party`: a listed supplier's uuid, or a hand-typed supplier's key. */
const splitParty = (party: string): { supplierId: string | null; manualKey: string | null } =>
  UUID_RE.test(party) ? { supplierId: party, manualKey: null } : { supplierId: null, manualKey: party };

export async function findQuote(rfqId: string, party: string): Promise<QuoteRow | null> {
  const { supplierId, manualKey } = splitParty(party);
  const r = await query<QuoteBase>(
    `select ${QUOTE_COLS} from public.purchasing_quotes q
       left join public.suppliers s on s.id = q.supplier_id
      where q.rfq_id = $1 and q.supplier_id is not distinct from $2::uuid
        and q.manual_key is not distinct from $3::text`,
    [rfqId, supplierId, manualKey],
  );
  return (await hydrateQuotes(r.rows))[0] ?? null;
}

export interface UpsertQuoteInput {
  rfq_id: string;
  /** null = a hand-typed supplier; `party` then carries its key and details. */
  supplier_id: string | null;
  party?: ManualParty | null;
  source: 'portal' | 'manual';
  total_amount: number | null;
  valid_until: string | null;
  notes: string;
  /** line id → unit price; the caller has verified every id belongs to the RFQ. */
  prices: Record<string, number>;
  actor_id: string | null;
}

/** Creates or replaces the supplier's single quote on the request. The price
 *  set is replaced wholesale (the form always sends the full set). */
export async function upsertQuote(input: UpsertQuoteInput): Promise<string> {
  return withTransaction(async (client) => {
    const common = [input.source, input.total_amount, input.valid_until, input.notes, input.actor_id];
    const q = input.supplier_id
      ? await client.query<{ id: string }>(
          `insert into public.purchasing_quotes
             (rfq_id, supplier_id, source, total_amount, valid_until, notes, created_by)
           values ($1, $2, $3, $4, $5, $6, $7)
           on conflict (rfq_id, supplier_id) do update
             set source = excluded.source, total_amount = excluded.total_amount,
                 valid_until = excluded.valid_until, notes = excluded.notes,
                 updated_at = now()
           returning id`,
          [input.rfq_id, input.supplier_id, ...common],
        )
      : await client.query<{ id: string }>(
          `insert into public.purchasing_quotes
             (rfq_id, supplier_id, source, total_amount, valid_until, notes, created_by,
              manual_key, supplier_name, supplier_phone, supplier_email, supplier_address)
           values ($1, null, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           on conflict (rfq_id, manual_key) where manual_key is not null do update
             set source = excluded.source, total_amount = excluded.total_amount,
                 valid_until = excluded.valid_until, notes = excluded.notes,
                 updated_at = now()
           returning id`,
          [
            input.rfq_id, ...common, input.party?.key ?? null, input.party?.name ?? null, input.party?.phone ?? null,
            input.party?.email ?? null, input.party?.address ?? null,
          ],
        );
    const id = q.rows[0].id;
    await client.query(`delete from public.purchasing_quote_lines where quote_id = $1`, [id]);
    for (const [lineId, price] of Object.entries(input.prices)) {
      await client.query(
        `insert into public.purchasing_quote_lines (quote_id, line_id, unit_price) values ($1, $2, $3)`,
        [id, lineId, price],
      );
    }
    return id;
  });
}

export async function deleteQuote(rfqId: string, party: string): Promise<FileRow[]> {
  const q = await findQuote(rfqId, party);
  if (!q) return [];
  const { supplierId, manualKey } = splitParty(party);
  await query(`delete from public.purchasing_quotes where id = $1`, [q.id]);
  // If the deleted offer was the winner, the choice goes with it.
  await query(
    `update public.purchasing_documents
        set winner_supplier_id = null, winner_manual_key = null, winner_chosen_by = null, winner_chosen_at = null,
            updated_at = now()
      where id = $1 and winner_chosen_at is not null and winner_supplier_id is not distinct from $2::uuid
        and winner_manual_key is not distinct from $3::text`,
    [rfqId, supplierId, manualKey],
  );
  return q.files;
}

/** `party`: a listed supplier's uuid, a hand-typed supplier's key (stored as
 *  winner_supplier_id null + winner_manual_key + winner_chosen_at set), or null
 *  to clear the choice. */
export async function setWinner(rfqId: string, party: string | null, userId: string): Promise<void> {
  const { supplierId, manualKey } = party === null ? { supplierId: null, manualKey: null } : splitParty(party);
  await query(
    `update public.purchasing_documents
        set winner_supplier_id = $2::uuid, winner_manual_key = $5::text,
            winner_chosen_by = case when $4 then null else $3::uuid end,
            winner_chosen_at = case when $4 then null else now() end,
            updated_at = now()
      where id = $1 and doc_type = 'rfq' and deleted_at is null`,
    [rfqId, supplierId, userId, party === null, manualKey],
  );
}

/** Shapes the quotes for the pure comparison code. */
export function toCompareQuotes(quotes: readonly QuoteRow[]) {
  return quotes.map((q) => ({
    supplier_id: partyKey(q),
    supplier_name: q.supplier_name,
    prices: q.prices,
    total_amount: q.total_amount,
  }));
}

/** The pre-VAT total of a quote against the request lines (lines, else lump sum). */
export function quoteSubtotal(
  lines: ReadonlyArray<{ id: string; description: string; quantity: number }>,
  q: Pick<QuoteRow, 'prices' | 'total_amount'>,
): number | null {
  return quoteTotal(lines, q).total;
}

// ── Files ───────────────────────────────────────────────────────────────────

export interface InsertFileInput {
  document_id: string | null;
  quote_id: string | null;
  object_key: string;
  original_filename: string;
  mime_type: string;
  file_size: number;
  uploaded_via: 'staff' | 'supplier';
  uploaded_by: string | null;
}

export async function insertFile(input: InsertFileInput): Promise<FileRow> {
  const r = await queryOne<FileRow>(
    `insert into public.purchasing_files
       (document_id, quote_id, object_key, original_filename, mime_type, file_size, uploaded_via, uploaded_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning id, document_id, quote_id, object_key, original_filename, mime_type,
               file_size::int as file_size, uploaded_via, created_at`,
    [
      input.document_id, input.quote_id, input.object_key, input.original_filename.slice(0, 300),
      input.mime_type, input.file_size, input.uploaded_via, input.uploaded_by,
    ],
  );
  return r as FileRow;
}

export async function findFile(id: string): Promise<FileRow | null> {
  return queryOne<FileRow>(
    `select id, document_id, quote_id, object_key, original_filename, mime_type,
            file_size::int as file_size, uploaded_via, created_at
       from public.purchasing_files where id = $1`,
    [id],
  );
}

export async function deleteFileRow(id: string): Promise<void> {
  await query(`delete from public.purchasing_files where id = $1`, [id]);
}

export async function countFiles(owner: { document_id?: string; quote_id?: string }): Promise<number> {
  const r = await queryOne<{ c: number }>(
    owner.document_id
      ? `select count(*)::int as c from public.purchasing_files where document_id = $1`
      : `select count(*)::int as c from public.purchasing_files where quote_id = $1`,
    [owner.document_id ?? owner.quote_id],
  );
  return r?.c ?? 0;
}

// ── Dispatch log ────────────────────────────────────────────────────────────

export interface DispatchRow {
  id: string;
  document_id: string;
  supplier_id: string | null;
  supplier_name: string;
  channel: 'email' | 'whatsapp';
  status: 'sent' | 'failed';
  error: string | null;
  sent_at: string;
}

export async function logDispatch(input: {
  document_id: string; supplier_id: string | null; manual_key?: string | null; supplier_name: string | null; channel: 'email' | 'whatsapp';
  status: 'sent' | 'failed'; error: string | null; sent_by: string;
}): Promise<void> {
  await query(
    `insert into public.purchasing_dispatches (document_id, supplier_id, manual_key, supplier_name, channel, status, error, sent_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [input.document_id, input.supplier_id, input.manual_key ?? null, input.supplier_id ? null : input.supplier_name, input.channel, input.status, input.error, input.sent_by],
  );
}

export async function listDispatches(documentId: string): Promise<DispatchRow[]> {
  const r = await query<DispatchRow>(
    `select x.id, x.document_id, x.supplier_id,
            coalesce(nullif(s.company_name, ''), s.display_name, nullif(x.supplier_name, '')) as supplier_name,
            x.channel, x.status, x.error, x.sent_at
       from public.purchasing_dispatches x
       left join public.suppliers s on s.id = x.supplier_id
      where x.document_id = $1 order by x.sent_at desc`,
    [documentId],
  );
  return r.rows;
}
