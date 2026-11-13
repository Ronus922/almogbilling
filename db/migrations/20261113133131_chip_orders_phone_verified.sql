-- migrate:up
-- Chip orders: "דלג על אימות (מצב בדיקה)" (13/11/2026). With SMS credit at 0
-- no phone code arrived, so Ronen could not create a test order at all. A TEST
-- order (valid test link) may now skip the phone code; it is stored with
-- phone_verified = false and /chips shows "טלפון לא אומת" on it.
--
-- Additive only:
--   1. chip_orders.phone_verified (default true) — every existing order was
--      created after a correct code, so it stays verified.
--   2. chip_orders_phone_verified_check — an unverified phone is allowed ONLY
--      on a test order. A real order without a verified code cannot exist,
--      whatever the application does.

alter table public.chip_orders
  add column phone_verified boolean not null default true;

comment on column public.chip_orders.phone_verified is
  'False only on a test order created with "דלג על אימות (מצב בדיקה)" — the phone code was skipped. A real order is always true (chip_orders_phone_verified_check).';

alter table public.chip_orders add constraint chip_orders_phone_verified_check
  check (phone_verified or is_test);

-- migrate:down
alter table public.chip_orders drop constraint chip_orders_phone_verified_check;
alter table public.chip_orders drop column phone_verified;
