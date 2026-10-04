-- migrate:up
-- Additional contact people of a supplier ("הוסף איש קשר נוסף", 04/10/2026).
--
-- The primary contact stays exactly where it is — suppliers.contact_person and
-- the supplier's phone / mobile / email columns are untouched. Rows here are
-- the 2nd, 3rd, … contact, each with a name, a free-text job title (role —
-- "תפקיד", NOT an RBAC role), one phone and one email. Text columns follow the
-- suppliers columns: not null default '' (empty = not filled).
--
-- The supplier panel saves the whole list at once: delete-all + insert inside
-- the supplier's own save transaction; sort_order = position on the panel.
-- Phones are stored as cleanPhoneField returns them, like suppliers.phone.
-- Not a message recipient and not searched — nothing outside the supplier
-- panel reads this table.
--
-- Suppliers are soft-deleted (deleted_at), so rows simply stay with their
-- hidden supplier; a hard delete (tests only) cascades.
--
-- Additive: one new table. No GRANT, no RLS (one service pool, src/lib/db.ts).

create table public.supplier_contacts (
  id          uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  name        text not null default '',
  role        text not null default '',
  phone       text not null default '',
  email       text not null default '',
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.supplier_contacts is
  'Additional contact people of a supplier (the primary one stays in suppliers.contact_person). The supplier panel replaces the whole list on save; sort_order = panel order.';
comment on column public.supplier_contacts.role is
  'Free-text job title (תפקיד) — not an RBAC role.';

create index supplier_contacts_supplier_id_idx
  on public.supplier_contacts (supplier_id, sort_order);

create trigger supplier_contacts_touch_updated_at
  before update on public.supplier_contacts
  for each row execute function public.touch_updated_at();

-- migrate:down
drop table if exists public.supplier_contacts;
