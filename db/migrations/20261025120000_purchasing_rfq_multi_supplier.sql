-- migrate:up
-- Purchasing RFQ, several suppliers on ONE request (25/10/2026). purchasing_* only.
--   1. The suppliers + the "send by" ticks of a request live in the form: a DRAFT
--      keeps them (purchasing_rfq_recipients rows + the two flags on the document).
--   2. A hand-typed supplier is told apart by a key (manual_key), so one request
--      can carry as many of them as the user types. Until now a request had at
--      most ONE (unique index on rfq_id where supplier_id is null).
--   3. A request no longer needs a document-level supplier: its suppliers are its
--      recipients. Purchase orders keep the rule.

-- ── 1. channel ticks of the form ────────────────────────────────────────────
alter table public.purchasing_documents
  add column send_email boolean not null default false,
  add column send_whatsapp boolean not null default false;

-- ── 2. manual_key ───────────────────────────────────────────────────────────
alter table public.purchasing_rfq_recipients add column manual_key text;
alter table public.purchasing_quotes         add column manual_key text;
alter table public.purchasing_dispatches     add column manual_key text;
alter table public.purchasing_documents      add column winner_manual_key text;

update public.purchasing_rfq_recipients
   set manual_key = 'm' || substr(md5(id::text), 1, 10)
 where supplier_id is null;

update public.purchasing_quotes q
   set manual_key = coalesce(
     (select rr.manual_key from public.purchasing_rfq_recipients rr
       where rr.rfq_id = q.rfq_id and rr.supplier_id is null limit 1),
     'm' || substr(md5(q.id::text), 1, 10))
 where q.supplier_id is null;

update public.purchasing_dispatches x
   set manual_key = (select rr.manual_key from public.purchasing_rfq_recipients rr
                      where rr.rfq_id = x.document_id and rr.supplier_id is null limit 1)
 where x.supplier_id is null;

update public.purchasing_documents d
   set winner_manual_key = coalesce(
     (select rr.manual_key from public.purchasing_rfq_recipients rr
       where rr.rfq_id = d.id and rr.supplier_id is null limit 1),
     (select q.manual_key from public.purchasing_quotes q
       where q.rfq_id = d.id and q.supplier_id is null limit 1))
 where d.winner_chosen_at is not null and d.winner_supplier_id is null;

drop index public.purchasing_rfq_recipients_manual_uidx;
drop index public.purchasing_quotes_manual_uidx;
create unique index purchasing_rfq_recipients_manual_uidx
  on public.purchasing_rfq_recipients (rfq_id, manual_key) where manual_key is not null;
create unique index purchasing_quotes_manual_uidx
  on public.purchasing_quotes (rfq_id, manual_key) where manual_key is not null;

alter table public.purchasing_rfq_recipients
  add constraint purchasing_rfq_recipients_key_xor check ((supplier_id is null) = (manual_key is not null));
alter table public.purchasing_quotes
  add constraint purchasing_quotes_key_xor check ((supplier_id is null) = (manual_key is not null));

-- ── 3. a request's suppliers are its recipients ─────────────────────────────
alter table public.purchasing_documents drop constraint purchasing_documents_has_supplier;
alter table public.purchasing_documents
  add constraint purchasing_documents_has_supplier check (
    deleted_at is not null or status = 'draft' or doc_type = 'rfq'
    or supplier_id is not null or nullif(btrim(coalesce(supplier_name, '')), '') is not null
  ) not valid;

-- migrate:down
-- A request with several hand-typed suppliers cannot go back to "at most one":
-- the extra recipients / quotes (oldest kept) are removed.
delete from public.purchasing_quotes q
 where q.manual_key is not null and q.id <> (
   select q2.id from public.purchasing_quotes q2
    where q2.rfq_id = q.rfq_id and q2.manual_key is not null order by q2.submitted_at, q2.id limit 1);
delete from public.purchasing_rfq_recipients rr
 where rr.manual_key is not null and rr.id <> (
   select r2.id from public.purchasing_rfq_recipients r2
    where r2.rfq_id = rr.rfq_id and r2.manual_key is not null order by r2.created_at, r2.id limit 1);
update public.purchasing_documents
   set winner_chosen_by = null, winner_chosen_at = null
 where winner_supplier_id is null and winner_chosen_at is not null
   and not exists (select 1 from public.purchasing_quotes q where q.rfq_id = purchasing_documents.id and q.manual_key is not null);

alter table public.purchasing_documents drop constraint purchasing_documents_has_supplier;
alter table public.purchasing_documents
  add constraint purchasing_documents_has_supplier check (
    deleted_at is not null or status = 'draft'
    or supplier_id is not null or nullif(btrim(coalesce(supplier_name, '')), '') is not null
  ) not valid;

alter table public.purchasing_quotes drop constraint purchasing_quotes_key_xor;
alter table public.purchasing_rfq_recipients drop constraint purchasing_rfq_recipients_key_xor;
drop index public.purchasing_quotes_manual_uidx;
drop index public.purchasing_rfq_recipients_manual_uidx;
create unique index purchasing_rfq_recipients_manual_uidx
  on public.purchasing_rfq_recipients (rfq_id) where supplier_id is null;
create unique index purchasing_quotes_manual_uidx
  on public.purchasing_quotes (rfq_id) where supplier_id is null;

alter table public.purchasing_documents drop column winner_manual_key;
alter table public.purchasing_dispatches drop column manual_key;
alter table public.purchasing_quotes drop column manual_key;
alter table public.purchasing_rfq_recipients drop column manual_key;
alter table public.purchasing_documents drop column send_whatsapp, drop column send_email;
