-- migrate:up
-- Issuing a chip at the reception (25/11/2026).
--
-- "הנפק צ׳יפ" — the issue window opened with no order — now collects what the
-- public order form collects (who orders, the holder's email, a renter's
-- lease) and records how the chips were paid:
--   · paid at the reception (cash or a bank transfer) → a chip order of its
--     own, source 'reception', linked to its people and its chips exactly like
--     an order of the public page. It is already paid and the chips are handed
--     over on the spot, so it is stored as collected;
--   · no charge → no order, as before. What the window collected is kept on a
--     reception record, and every chip of that save points at it.
--
-- Additive only. Every existing row keeps every value it has, and a row of the
-- public page (source 'web', the default) stays under exactly the rules it was
-- under: each rule below that had to make room for a reception order is
-- rewritten as "<the rule as it was> for a web order, <the reception rule> for
-- a reception order".
--
--   1. chip_orders.source               — 'web' (default) | 'reception'.
--   2. chip_orders.payment_method       — how a reception order was paid
--                                         ('cash_transfer'). NULL on a web order.
--      chip_orders.payment_recorded_by / _by_name / _at — who recorded that
--                                         payment, and when.
--   3. chip_orders phone / email / address — a reception order may have none
--                                         (the manager is not required to fill
--                                         them); a web order still must.
--      chip_orders.role                 — a reception order may be placed for a
--                                         guest ('other') or for staff.
--      chip_orders "paid" rule          — a reception order is paid with no
--                                         Grow transaction.
--   4. chip_order_holders.source        — + 'reception': a person of a
--                                         reception order (part of what was
--                                         paid; the phone is optional).
--   5. chip_reception_records           — one row per no-charge save of the
--                                         reception window: who ordered, how
--                                         many chips, and the price that was
--                                         not charged.
--   6. chips.reception_record_id        — the no-charge record a chip belongs to.
--      chips.holder_email               — the holder's email (a snapshot, like
--                                         holder_name / holder_phone).
--      chips.lease_file_* / lease_end_date — a renter's lease and its end date
--                                         (the same private bucket as the
--                                         leases of web orders).

alter table public.chip_orders
  add column source text not null default 'web',
  add column payment_method text,
  add column payment_recorded_by uuid references public.users (id) on delete set null,
  add column payment_recorded_by_name text,
  add column payment_recorded_at timestamptz;

alter table public.chip_orders
  alter column phone_e164 drop not null,
  alter column email drop not null,
  alter column address drop not null;

alter table public.chip_orders
  drop constraint chip_orders_phone_e164_check,
  drop constraint chip_orders_email_check,
  drop constraint chip_orders_address_check,
  drop constraint chip_orders_role_check,
  drop constraint chip_orders_paid_fields_check;

alter table public.chip_orders
  add constraint chip_orders_source_check
    check (source in ('web', 'reception')),
  add constraint chip_orders_phone_e164_check
    check (
      (source = 'reception' and (phone_e164 is null or length(btrim(phone_e164)) between 5 and 32))
      or (source <> 'reception' and phone_e164 is not null and phone_e164 ~ '^\+9725[0-9]{8}$')
    ),
  add constraint chip_orders_email_check
    check (
      (source = 'reception' and email is null)
      or (email is not null and length(btrim(email)) between 3 and 254)
    ),
  add constraint chip_orders_address_check
    check (
      (source = 'reception' and address is null)
      or (address is not null and length(btrim(address)) between 2 and 300)
    ),
  add constraint chip_orders_role_check
    check (
      role in ('owner', 'tenant', 'operator')
      or (source = 'reception' and role in ('other', 'staff'))
    ),
  add constraint chip_orders_paid_fields_check
    check (
      status = 'pending_payment'
      or (paid_at is not null and (grow_transaction_id is not null or is_test or source = 'reception'))
    ),
  add constraint chip_orders_payment_method_check
    check (payment_method is null or payment_method = 'cash_transfer'),
  -- A reception order: never a test order, never a Grow order, always with its
  -- payment on record.
  add constraint chip_orders_reception_check
    check (
      source <> 'reception'
      or (not is_test
          and grow_process_id is null and grow_transaction_id is null
          and payment_method is not null
          and payment_recorded_at is not null
          and payment_recorded_by_name is not null)
    );

create index chip_orders_reception_idx on public.chip_orders (paid_at desc) where source = 'reception';

comment on column public.chip_orders.source is
  'Where the order was made: ''web'' = the public page /chip-order; ''reception'' = the staff issued the chips in the issue window ("הנפק צ׳יפ") and recorded a payment received at the reception. A reception order is created paid and collected, sends no message to anyone, and is never a test order.';
comment on column public.chip_orders.payment_method is
  'How a reception order was paid: ''cash_transfer'' = cash or a bank transfer, confirmed as received by whoever recorded it. NULL on a web order (paid through the clearing provider, or a test order).';
comment on column public.chip_orders.payment_recorded_by_name is
  'Who recorded the payment of a reception order (the name at that moment; payment_recorded_by is the user, NULL once the user is deleted). The amount is `total`, the time payment_recorded_at.';

alter table public.chip_order_holders
  drop constraint chip_order_holders_source_check,
  drop constraint chip_order_holders_order_row_check;

alter table public.chip_order_holders
  add constraint chip_order_holders_source_check
    check (source in ('order', 'staff', 'reception')),
  add constraint chip_order_holders_order_row_check
    check (
      source = 'staff'
      or (source = 'order' and chips_count >= 1 and phone is not null)
      or (source = 'reception' and chips_count >= 1)
    );

create table public.chip_reception_records (
  id               uuid primary key default gen_random_uuid(),
  contact_id       uuid not null references public.contacts (id) on delete restrict,
  apartment_number text not null,
  orderer_name     text check (orderer_name is null or length(btrim(orderer_name)) between 1 and 120),
  orderer_phone    text check (orderer_phone is null or length(btrim(orderer_phone)) between 5 and 32),
  orderer_email    text check (orderer_email is null or length(btrim(orderer_email)) between 3 and 254),
  address_street   text check (address_street is null or length(btrim(address_street)) between 2 and 200),
  address_city     text check (address_city is null or length(btrim(address_city)) between 2 and 100),
  address_zip      text check (address_zip is null or address_zip ~ '^[0-9]{7}$'),
  chips_count      integer not null check (chips_count >= 1),
  unit_price       numeric(10,2) not null check (unit_price >= 0),
  created_by       uuid references public.users (id) on delete set null,
  created_by_name  text,
  created_at       timestamptz not null default now()
);

create index chip_reception_records_contact_idx on public.chip_reception_records (contact_id, created_at desc);

comment on table public.chip_reception_records is
  'Chips issued at the reception WITHOUT a charge ("ללא חיוב": a guest, staff, a replacement) — one row per save of the issue window. No order is created for such a save; this row keeps who ordered (all optional), how many chips, the price per chip that was not charged, and who issued them. A paid reception issue is a chip order (chip_orders.source = ''reception'') instead.';

alter table public.chips
  add column holder_email text check (holder_email is null or length(btrim(holder_email)) between 3 and 254),
  add column lease_file_key text,
  add column lease_file_name text,
  add column lease_file_mime text,
  add column lease_file_size integer check (lease_file_size is null or lease_file_size > 0),
  add column lease_end_date date,
  add column reception_record_id uuid references public.chip_reception_records (id) on delete set null,
  add constraint chips_lease_pair_check check ((lease_file_key is null) = (lease_file_name is null));

-- Every open of a lease (/api/files/chip-order-leases/<key>) looks the chip up
-- by this key. Not unique: a person's lease sits on every chip of that person.
create index chips_lease_file_key_idx on public.chips (lease_file_key) where lease_file_key is not null;
create index chips_reception_record_idx on public.chips (reception_record_id) where reception_record_id is not null;

comment on column public.chips.holder_email is
  'The holder''s email as typed in the issue window — a snapshot, like holder_name and holder_phone. NULL for every chip issued before 25/11/2026.';
comment on column public.chips.lease_file_key is
  'A renter''s lease attached in the issue window: the object key in the private bucket chip-order-leases (served only through /api/files). The same key sits on every chip of that person.';
comment on column public.chips.reception_record_id is
  'The no-charge reception record this chip was issued under (chip_reception_records). NULL for a chip of an order and for every chip issued before 25/11/2026.';
comment on column public.chips.issuance_fee is
  'History: the "עמלת הנפקה (₪)" field of the issue window, removed 25/11/2026. Not written since — what a chip cost is on its order (chip_orders.total) or on its reception record.';
comment on column public.chips.fee_charged is
  'History: the "החיוב בוצע" checkbox of the issue window, removed 25/11/2026. Not written since.';

-- migrate:down
-- Refuses while anything of the reception flow is stored: rolling back would
-- lose recorded payments and orphan leases in Storage. Deleting those rows is
-- a human decision.
do $$
begin
  if exists (select 1 from public.chip_orders where source = 'reception') then
    raise exception 'down refused: chip_orders holds reception orders — export / delete them on purpose first';
  end if;
  if exists (select 1 from public.chip_order_holders where source = 'reception') then
    raise exception 'down refused: chip_order_holders holds reception holder lines';
  end if;
  if exists (select 1 from public.chip_reception_records) then
    raise exception 'down refused: chip_reception_records has rows';
  end if;
  if exists (select 1 from public.chips
              where holder_email is not null or lease_file_key is not null or lease_end_date is not null) then
    raise exception 'down refused: chips hold values in the 25/11/2026 columns (holder_email / lease)';
  end if;
end
$$;

comment on column public.chips.fee_charged is null;
comment on column public.chips.issuance_fee is null;

drop index if exists public.chips_reception_record_idx;
drop index if exists public.chips_lease_file_key_idx;
alter table public.chips
  drop constraint chips_lease_pair_check,
  drop column reception_record_id,
  drop column lease_end_date,
  drop column lease_file_size,
  drop column lease_file_mime,
  drop column lease_file_name,
  drop column lease_file_key,
  drop column holder_email;

drop table public.chip_reception_records;

alter table public.chip_order_holders
  drop constraint chip_order_holders_source_check,
  drop constraint chip_order_holders_order_row_check;
alter table public.chip_order_holders
  add constraint chip_order_holders_source_check check (source in ('order', 'staff')),
  add constraint chip_order_holders_order_row_check check (source = 'staff' or (chips_count >= 1 and phone is not null));

drop index if exists public.chip_orders_reception_idx;
alter table public.chip_orders
  drop constraint chip_orders_reception_check,
  drop constraint chip_orders_payment_method_check,
  drop constraint chip_orders_paid_fields_check,
  drop constraint chip_orders_role_check,
  drop constraint chip_orders_address_check,
  drop constraint chip_orders_email_check,
  drop constraint chip_orders_phone_e164_check,
  drop constraint chip_orders_source_check;
alter table public.chip_orders
  alter column phone_e164 set not null,
  alter column email set not null,
  alter column address set not null;
alter table public.chip_orders
  add constraint chip_orders_phone_e164_check check (phone_e164 ~ '^\+9725[0-9]{8}$'),
  add constraint chip_orders_email_check check (length(btrim(email)) between 3 and 254),
  add constraint chip_orders_address_check check (length(btrim(address)) between 2 and 300),
  add constraint chip_orders_role_check check (role in ('owner', 'tenant', 'operator')),
  add constraint chip_orders_paid_fields_check check (status = 'pending_payment' or (paid_at is not null and (grow_transaction_id is not null or is_test)));
alter table public.chip_orders
  drop column payment_recorded_at,
  drop column payment_recorded_by_name,
  drop column payment_recorded_by,
  drop column payment_method,
  drop column source;
