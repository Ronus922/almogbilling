-- migrate:up
-- Chip orders: card payment for REAL orders, and an order form without a phone
-- code (26/11/2026, night run — docs/chip-orders.md "תשלומים מקצה לקצה").
--
-- Relaxations only. Every existing row satisfies every rule below, and every
-- write of the code that ran before this migration stays valid, so
-- `deploy:rollback` runs on this schema without undoing it.
--
-- 1. chip_orders.phone_verified may be NULL. The order form has no phone code
--    step any more; a new order stores NULL ("the form had no code step").
--    Rows written before keep their true / false. chip_orders_phone_verified_check
--    (phone_verified OR is_test) is not touched: a CHECK accepts NULL.
-- 2. chip_orders_paid_fields_check is replaced by a WIDER rule: an order may
--    also leave pending_payment when the processor confirmed a card charge
--    (card_status = 'paid' — chip_orders_card_paid_check already demands the
--    transaction id, the amount, the time and amount = total for that).
--    Whether a REAL order may pay by card at all is decided by the code (the
--    live-charging switch, PAYPLUS_MODE=production and its three values), and
--    chip_orders_card_env_test_check keeps a sandbox charge off a real order.
-- 3. chip_order_card_sessions.amount — the amount each payment session was
--    opened for (NULL on the sessions opened before this migration).
--
-- DOWN refuses while an order has phone_verified NULL or is a real web order
-- paid by card: putting the old rules back would make those rows invalid.

alter table public.chip_orders alter column phone_verified drop not null;
comment on column public.chip_orders.phone_verified is
  'Did the orderer''s phone pass a code? NULL = the order form had no code step (every order from 26/11/2026). True = verified by a code, false = a test order made with "דלג על אימות (מצב בדיקה)" (both until 26/11/2026). A real order is never false (chip_orders_phone_verified_check).';

alter table public.chip_orders drop constraint chip_orders_paid_fields_check;
-- NULL-safe on purpose: card_status is NULL on most orders, and a bare
-- `card_status = 'paid'` would make the whole rule NULL — which a CHECK lets
-- through (a real order marked paid with no payment at all).
alter table public.chip_orders add constraint chip_orders_paid_fields_check check (
  status = 'pending_payment'
  or (
    paid_at is not null
    and (grow_transaction_id is not null or is_test or source = 'reception' or card_status is not distinct from 'paid')
  )
);

alter table public.chip_order_card_sessions add column amount numeric(10,2);
alter table public.chip_order_card_sessions
  add constraint chip_order_card_sessions_amount_check check (amount is null or amount > 0);
comment on column public.chip_order_card_sessions.amount is
  'The amount this payment session was opened for (the server computed it from the saved order). NULL on sessions opened before 26/11/2026.';

-- migrate:down
do $$
begin
  if exists (select 1 from public.chip_orders where phone_verified is null) then
    raise exception 'chip_order_live_card down: orders made without a phone code step exist (phone_verified is null) — refusing';
  end if;
  if exists (
    select 1 from public.chip_orders
     where status <> 'pending_payment' and grow_transaction_id is null and not is_test and source <> 'reception'
  ) then
    raise exception 'chip_order_live_card down: real web orders paid by card exist — refusing';
  end if;
end $$;

alter table public.chip_order_card_sessions drop constraint chip_order_card_sessions_amount_check;
alter table public.chip_order_card_sessions drop column amount;

alter table public.chip_orders drop constraint chip_orders_paid_fields_check;
alter table public.chip_orders add constraint chip_orders_paid_fields_check check (
  status = 'pending_payment'
  or (paid_at is not null and (grow_transaction_id is not null or is_test or source = 'reception'))
);

alter table public.chip_orders alter column phone_verified set not null;
comment on column public.chip_orders.phone_verified is
  'False only on a test order created with "דלג על אימות (מצב בדיקה)" — the phone code was skipped. A real order is always true (chip_orders_phone_verified_check).';
