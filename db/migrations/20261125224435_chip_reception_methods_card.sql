-- migrate:up
-- Chip orders at the reception (26/11/2026, night run — docs/chip-orders.md
-- "קבלה: מזומן, העברה, אשראי"):
--   1. "מזומן או העברה" splits into "מזומן" and "העברה בנקאית" — the Morning
--      document needs the real payment type. New orders store 'cash' or
--      'bank_transfer'; the orders recorded before keep 'cash_transfer' and are
--      shown as they were.
--   2. "אשראי" at the reception becomes real (admin / super admin): a reception
--      order may carry a card payment (PayPlus hosted fields, the same server
--      rules as the public page). Its sandbox TEST mode makes a TEST reception
--      order — card only, never cash or a transfer — so it can be tried
--      without creating a real order, and deleted like any test order.
--
-- Three CHECKs are REPLACED BY WIDER ONES. Every existing row satisfies the
-- new rules, and nothing the code that ran before writes is refused by them
-- (it writes only 'cash_transfer', never a card on a reception order, never a
-- test reception order) — so `deploy:rollback` runs on this schema.
--
--   chip_orders_payment_method_check: cash_transfer (history) | cash |
--     bank_transfer | card.
--   chip_orders_card_web_check: a card record on a web OR a reception order.
--   chip_orders_reception_check: as before, except that a reception order
--     paid by card in the sandbox may be a test order (card only — cash or a
--     transfer is never a test).
--
-- DOWN refuses while any order stores one of the new values.

alter table public.chip_orders drop constraint chip_orders_payment_method_check;
alter table public.chip_orders add constraint chip_orders_payment_method_check check (
  payment_method is null or payment_method in ('cash_transfer', 'cash', 'bank_transfer', 'card')
);

alter table public.chip_orders drop constraint chip_orders_card_web_check;
alter table public.chip_orders add constraint chip_orders_card_web_check check (
  card_status is null or source in ('web', 'reception')
);

alter table public.chip_orders drop constraint chip_orders_reception_check;
alter table public.chip_orders add constraint chip_orders_reception_check check (
  source <> 'reception'
  or ((not is_test or (payment_method = 'card' and card_env is distinct from 'production'))
      and grow_process_id is null and grow_transaction_id is null
      and payment_method is not null
      and payment_recorded_at is not null
      and payment_recorded_by_name is not null)
);

comment on column public.chip_orders.payment_method is
  'How a reception order was paid: ''cash'', ''bank_transfer'' (both confirmed as received by whoever recorded them), ''card'' (PayPlus at the reception, from 26/11/2026), or ''cash_transfer'' (cash or a bank transfer, recorded before 26/11/2026). NULL on a web order.';

-- migrate:down
do $$
begin
  if exists (select 1 from public.chip_orders where payment_method in ('cash', 'bank_transfer', 'card')) then
    raise exception 'chip_reception_methods_card down: orders store cash / bank_transfer / card — refusing';
  end if;
  if exists (select 1 from public.chip_orders where card_status is not null and source <> 'web') then
    raise exception 'chip_reception_methods_card down: reception orders paid by card exist — refusing';
  end if;
end $$;

alter table public.chip_orders drop constraint chip_orders_reception_check;
alter table public.chip_orders add constraint chip_orders_reception_check check (
  source <> 'reception'
  or (not is_test
      and grow_process_id is null and grow_transaction_id is null
      and payment_method is not null
      and payment_recorded_at is not null
      and payment_recorded_by_name is not null)
);
alter table public.chip_orders drop constraint chip_orders_card_web_check;
alter table public.chip_orders add constraint chip_orders_card_web_check check (card_status is null or source = 'web');
alter table public.chip_orders drop constraint chip_orders_payment_method_check;
alter table public.chip_orders add constraint chip_orders_payment_method_check check (payment_method is null or payment_method = 'cash_transfer');
comment on column public.chip_orders.payment_method is
  'How a reception order was paid: ''cash_transfer'' = cash or a bank transfer, confirmed as received by whoever recorded it. NULL on a web order (paid through the clearing provider, or a test order).';
