-- migrate:up
-- Chip orders, redesigned order page + issue window (20/11/2026).
--
-- On the public page every row is now ONE PERSON who will hold chips (role,
-- full name, apartment, quantity, phone, email); several rows may point to the
-- same apartment. The price stays per apartment (chip_order_items, one row per
-- apartment, its price snapshot unchanged), and every person row is stored as
-- a holder line under the apartment line, so every chip can be tied to a
-- holder name and phone.
--
-- Additive only:
--   1. chip_order_holders            — one row per person of an order. source
--                                      'order' = a row of the public page
--                                      (part of the paid quantity); 'staff' =
--                                      a holder the staff added in the issue
--                                      window (chips_count 0, never priced).
--                                      A renter row carries its own lease
--                                      (same private bucket chip-order-leases).
--   2. chip_order_items (id, order_id) unique — lets a holder line point at an
--                                      apartment line OF ITS OWN order (FK).
--   3. chips.order_holder_id         — nullable: the holder line a chip was
--                                      issued for. Every existing chip keeps NULL.
--   4. chip_orders.address_street / address_city / address_zip — the current
--                                      residential address, split. The old
--                                      `address` column stays (composed from
--                                      the three) for everything that reads it.
--   5. chip_orders.renter_terms_accepted_at — when the renter commitment box
--                                      was ticked (only when a renter row exists).
--   6. chip_orders.internal_note     — the staff's internal note on the order.
--
-- No existing row or value changes. Existing orders keep no holder lines; the
-- issue window builds one block per apartment for them from the order itself.

create unique index chip_order_items_id_order_uniq on public.chip_order_items (id, order_id);

create table public.chip_order_holders (
  id               uuid primary key default gen_random_uuid(),
  order_id         uuid not null references public.chip_orders (id) on delete cascade,
  item_id          uuid not null,
  position         integer not null default 0,
  source           text not null default 'order' check (source in ('order', 'staff')),
  role             text not null check (role in ('owner', 'tenant', 'operator', 'other', 'staff')),
  full_name        text not null check (length(btrim(full_name)) between 2 and 120),
  phone            text check (phone is null or length(btrim(phone)) between 5 and 32),
  email            text check (email is null or length(btrim(email)) between 3 and 254),
  chips_count      integer not null default 0 check (chips_count between 0 and 50),
  lease_file_key   text,
  lease_file_name  text,
  lease_file_mime  text,
  lease_file_size  integer check (lease_file_size is null or lease_file_size > 0),
  lease_end_date   date,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint chip_order_holders_item_fkey
    foreign key (item_id, order_id) references public.chip_order_items (id, order_id) on delete cascade,
  constraint chip_order_holders_order_row_check
    check (source = 'staff' or (chips_count >= 1 and phone is not null)),
  constraint chip_order_holders_lease_pair_check
    check ((lease_file_key is null) = (lease_file_name is null))
);

create index chip_order_holders_order_idx on public.chip_order_holders (order_id, position);
create index chip_order_holders_item_idx on public.chip_order_holders (item_id);
-- Every open of a lease (/api/files/chip-order-leases/<key>) looks the row up by this key.
create unique index chip_order_holders_lease_file_key_idx
  on public.chip_order_holders (lease_file_key) where lease_file_key is not null;

comment on table public.chip_order_holders is
  'One person of a chip order (a row of /chip-order, or a holder the staff added in the issue window). Price stays on chip_order_items (per apartment); a renter row keeps its lease here.';

alter table public.chips
  add column order_holder_id uuid references public.chip_order_holders (id) on delete set null;

create index chips_order_holder_idx on public.chips (order_holder_id) where order_holder_id is not null;

comment on column public.chips.order_holder_id is
  'The chip-order holder line (person) this chip was issued for. NULL for every chip issued outside an order and for chips of orders made before 20/11/2026.';

alter table public.chip_orders
  add column address_street text check (address_street is null or length(btrim(address_street)) between 2 and 200),
  add column address_city text check (address_city is null or length(btrim(address_city)) between 2 and 100),
  add column address_zip text check (address_zip is null or address_zip ~ '^[0-9]{7}$'),
  add column renter_terms_accepted_at timestamptz,
  add column internal_note text check (internal_note is null or length(internal_note) <= 2000);

comment on column public.chip_orders.renter_terms_accepted_at is
  'When the orderer ticked "השוכר מתחייב להחזיר את הכרטיס…" — set only when the order has a renter row.';
comment on column public.chip_orders.internal_note is
  'The staff''s internal note on the order (issue window, "פירוט עסקה והערות"). Never shown to the orderer.';

-- migrate:down
-- Refuses while the new data exists: dropping it would lose who holds which
-- chips and orphan renter leases in Storage. Deleting it is a human decision.
do $$
begin
  if exists (select 1 from public.chip_order_holders) then
    raise exception 'down refused: chip_order_holders has rows — delete those orders (and their leases in chip-order-leases) on purpose first';
  end if;
  if exists (select 1 from public.chip_orders
              where address_street is not null or address_city is not null or address_zip is not null
                 or renter_terms_accepted_at is not null or internal_note is not null) then
    raise exception 'down refused: chip_orders has values in the 20/11/2026 columns';
  end if;
end
$$;

alter table public.chip_orders
  drop column internal_note,
  drop column renter_terms_accepted_at,
  drop column address_zip,
  drop column address_city,
  drop column address_street;

drop index if exists public.chips_order_holder_idx;
alter table public.chips drop column order_holder_id;

drop table public.chip_order_holders;
drop index if exists public.chip_order_items_id_order_uniq;
