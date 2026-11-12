-- migrate:up
-- Elevator-chip orders, phase A (12/11/2026). A resident orders chips on the
-- public page /chip-order, pays through Grow, and the order is handled inside
-- the EXISTING chips module (/chips) — there is no second chips table.
--
-- Additive only:
--   1. chip_orders              — one row per order (who ordered, the Grow
--                                 payment, the status and its timestamps).
--   2. chip_order_items         — one row per apartment of an order, with the
--                                 price snapshot taken when it was ordered and
--                                 the lease file of a tenant / operator.
--   3. chip_order_notifications — every email / WhatsApp sent (or failed) for
--                                 an order, so a failure is visible on it.
--   4. chips.order_item_id      — nullable: the order line a chip was issued
--                                 for. Every existing chip keeps NULL and every
--                                 existing column is untouched.
--   5. portal_otp_codes.purpose — the portal's one-time codes also serve the
--                                 order page's phone check. Every existing row
--                                 is 'portal_login' (the default), and the
--                                 portal reads only those, so a chip-order code
--                                 can never open a portal session.
--
-- Payment fields (grow_*) are written only by the server after Grow confirms
-- the payment through its own API. process_token / transaction_token never
-- leave the server.

create table public.chip_orders (
  id                  uuid primary key default gen_random_uuid(),
  order_number        integer generated always as identity (start with 1001) unique,
  full_name           text not null check (length(btrim(full_name)) between 2 and 120),
  phone_e164          text not null check (phone_e164 ~ '^\+9725[0-9]{8}$'),
  email               text not null check (length(btrim(email)) between 3 and 254),
  address             text not null check (length(btrim(address)) between 2 and 300),
  role                text not null check (role in ('owner', 'tenant', 'operator')),
  status              text not null default 'pending_payment'
                        check (status in ('pending_payment', 'paid', 'approved', 'ready', 'collected', 'rejected')),
  total               numeric(10,2) not null check (total > 0),
  grow_process_id     text,
  grow_process_token  text,
  grow_transaction_id text,
  grow_transaction_token text,
  grow_asmachta       text,
  invoice_url         text,
  invoice_number      text,
  paid_at             timestamptz,
  tracking_token      text not null unique check (length(tracking_token) >= 32),
  approved_at         timestamptz,
  due_at              timestamptz,
  ready_at            timestamptz,
  collected_at        timestamptz,
  rejected_at         timestamptz,
  reject_reason       text,
  refund_status       text check (refund_status is null or refund_status in ('refunded', 'manual_required')),
  refund_note         text,
  created_ip          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint chip_orders_reject_reason_check
    check (status <> 'rejected' or (reject_reason is not null and length(btrim(reject_reason)) > 0)),
  constraint chip_orders_paid_fields_check
    check (status = 'pending_payment' or (paid_at is not null and grow_transaction_id is not null))
);

create index chip_orders_status_idx on public.chip_orders (status, created_at desc);
create unique index chip_orders_grow_process_id_idx on public.chip_orders (grow_process_id) where grow_process_id is not null;

comment on table public.chip_orders is
  'Elevator-chip orders from the public page /chip-order. pending_payment rows are never shown in /chips; Grow confirms payment server-to-server and through its API before status becomes paid.';

create table public.chip_order_items (
  id                uuid primary key default gen_random_uuid(),
  order_id          uuid not null references public.chip_orders (id) on delete cascade,
  contact_id        uuid not null references public.contacts (id) on delete restrict,
  apartment_number  text not null,
  chips_count       integer not null check (chips_count between 1 and 50),
  unit_price        numeric(10,2) not null check (unit_price >= 0),
  threshold         integer not null check (threshold >= 0),
  price_above       numeric(10,2) not null check (price_above >= 0),
  line_total        numeric(10,2) not null check (line_total >= 0),
  lease_file_key    text,
  lease_file_name   text,
  lease_file_mime   text,
  lease_file_size   integer check (lease_file_size is null or lease_file_size > 0),
  lease_end_date    date,
  match_status      text not null check (match_status in ('matched', 'review', 'unassigned', 'document_review')),
  created_at        timestamptz not null default now(),
  constraint chip_order_items_order_contact_uniq unique (order_id, contact_id),
  constraint chip_order_items_lease_pair_check
    check ((lease_file_key is null) = (lease_file_name is null))
);

create index chip_order_items_order_idx on public.chip_order_items (order_id);
create index chip_order_items_contact_idx on public.chip_order_items (contact_id);
-- Every open of a lease (/api/files/chip-order-leases/<key>) looks the row up by this key.
create unique index chip_order_items_lease_file_key_idx on public.chip_order_items (lease_file_key) where lease_file_key is not null;

comment on table public.chip_order_items is
  'One apartment of a chip order. Price fields are a snapshot of the settings at order time. The lease lives in the private bucket chip-order-leases (key = <uuid>.<ext>), served only through /api/files.';

create table public.chip_order_notifications (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references public.chip_orders (id) on delete cascade,
  kind        text not null check (kind in ('paid', 'approved', 'ready', 'rejected')),
  channel     text not null check (channel in ('email', 'whatsapp')),
  status      text not null check (status in ('sent', 'failed', 'skipped')),
  error       text,
  created_at  timestamptz not null default now()
);

create index chip_order_notifications_order_idx on public.chip_order_notifications (order_id, created_at);

alter table public.chips
  add column order_item_id uuid references public.chip_order_items (id) on delete set null;

create index chips_order_item_idx on public.chips (order_item_id) where order_item_id is not null;

comment on column public.chips.order_item_id is
  'The chip-order line this chip was issued for (NULL for every chip issued outside an order).';

alter table public.portal_otp_codes
  add column purpose text not null default 'portal_login'
    constraint portal_otp_codes_purpose_check check (purpose in ('portal_login', 'chip_order'));

-- migrate:down
-- Refuses while orders exist: dropping the tables would destroy paid orders and
-- orphan their lease files in Storage. Deleting them is a human decision.
do $$
begin
  if exists (select 1 from public.chip_orders) then
    raise exception 'down refused: chip_orders has rows — export / delete them (and their leases in chip-order-leases) on purpose first';
  end if;
end
$$;

delete from public.portal_otp_codes where purpose = 'chip_order';
alter table public.portal_otp_codes drop column purpose;

drop index if exists public.chips_order_item_idx;
alter table public.chips drop column order_item_id;

drop table public.chip_order_notifications;
drop table public.chip_order_items;
drop table public.chip_orders;
