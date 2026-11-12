-- migrate:up
-- Chip orders: test mode (13/11/2026). Ronen walks the whole order flow before
-- there are Grow identifiers: a test order is created through a secret link,
-- marked paid WITHOUT Grow ("סיים הזמנת בדיקה"), and is otherwise a normal
-- order (messages, approve, chips, ready, collected, reject).
--
-- Additive only:
--   1. chip_orders.is_test (default false) — every existing order stays a real one.
--   2. chip_orders_paid_fields_check — a paid order needs a Grow transaction,
--      EXCEPT a test order (which never has one).
--   3. chip_orders_test_no_grow_check — a test order never carries Grow fields
--      or an invoice, so it can never look like (or be refunded as) a payment.
--   4. refund_status 'not_required' ("לא נדרש (בדיקה)") — a rejected test
--      order is never sent to Grow; only a test order may hold it.
--
-- The test-mode switch and the hash of its link live in app_settings (key
-- 'chip_orders_test_mode'), the existing settings store — no table here.

alter table public.chip_orders
  add column is_test boolean not null default false;

comment on column public.chip_orders.is_test is
  'A test order (test mode, /chip-order?test=…): paid without Grow, never refunded through Grow, excluded from every count and sum, never purged as unpaid, deleted only through "מחק הזמנת בדיקה".';

alter table public.chip_orders drop constraint chip_orders_paid_fields_check;
alter table public.chip_orders add constraint chip_orders_paid_fields_check
  check (status = 'pending_payment' or (paid_at is not null and (grow_transaction_id is not null or is_test)));

alter table public.chip_orders add constraint chip_orders_test_no_grow_check
  check (not is_test or (grow_process_id is null and grow_transaction_id is null and invoice_url is null));

alter table public.chip_orders drop constraint chip_orders_refund_status_check;
alter table public.chip_orders add constraint chip_orders_refund_status_check
  check (refund_status is null or refund_status in ('refunded', 'manual_required', 'not_required'));

alter table public.chip_orders add constraint chip_orders_refund_not_required_check
  check (refund_status is distinct from 'not_required' or is_test);

-- migrate:down
-- Refuses while test orders exist: their paid status has no Grow transaction,
-- so the original constraint cannot be restored over them. Delete them first
-- ("מחק את כל הזמנות הבדיקה" in /chips → הזמנות).
do $$
begin
  if exists (select 1 from public.chip_orders where is_test) then
    raise exception 'down refused: chip_orders has test orders — delete them in /chips (מחק את כל הזמנות הבדיקה) first';
  end if;
end
$$;

alter table public.chip_orders drop constraint chip_orders_refund_not_required_check;
alter table public.chip_orders drop constraint chip_orders_refund_status_check;
alter table public.chip_orders add constraint chip_orders_refund_status_check
  check (refund_status is null or refund_status in ('refunded', 'manual_required'));

alter table public.chip_orders drop constraint chip_orders_test_no_grow_check;

alter table public.chip_orders drop constraint chip_orders_paid_fields_check;
alter table public.chip_orders add constraint chip_orders_paid_fields_check
  check (status = 'pending_payment' or (paid_at is not null and grow_transaction_id is not null));

alter table public.chip_orders drop column is_test;
