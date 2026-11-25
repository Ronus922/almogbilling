-- migrate:up
-- Chip orders: card payment (25/11/2026). The public order page charges a card
-- through PayPlus hosted fields; what the processor confirmed is kept on the
-- order itself.
--
-- Additive only: new NULLABLE columns on chip_orders, constraints that speak
-- of those columns (and read, never change, the existing ones), and two
-- partial unique indexes. No existing column, constraint or row is changed —
-- every order keeps every value it has, and the code that ran before this
-- migration runs on it unchanged.
--
--   card_provider          who charged the card ('payplus').
--   card_env               the processor environment the session was opened
--                          in: 'sandbox' or 'production'.
--   card_status            'started' (a payment session was opened), 'paid'
--                          (the processor confirmed the charge), 'failed' (the
--                          last attempt was refused; the order still waits for
--                          payment).
--   card_page_request_uid  the processor's payment session of the order (the
--                          latest one), and card_session_at — when it was opened.
--   card_transaction_uid   the processor's transaction id of the PAID charge.
--   card_paid_amount       the amount the processor charged.
--   card_paid_at           when the charge was confirmed to us.
--   card_approval_number   the acquirer's approval number.
--   card_last4             the last four digits of the card.
--   card_failure_reason    why the last attempt failed, and card_failed_at.
--
-- NEVER stored, here or anywhere: the card number, its expiry, the CVV. They
-- are typed into the processor's own frames and never reach this server.
--
-- The rules the database itself keeps:
--   - a card record of the SANDBOX exists only on a TEST order, and a card
--     record of PRODUCTION never on one (chip_orders_card_env_test_check) — a
--     sandbox payment cannot be written onto a real order at all;
--   - 'paid' means: a transaction id, the amount, the time, an order that left
--     pending_payment, and the amount charged = the order's total;
--   - one processor transaction, and one payment session, belong to one order.
-- chip_orders_paid_fields_check (12/11/2026) is NOT touched: a real web order
-- still leaves pending_payment only with a Grow transaction. Opening card
-- payment to real orders is a separate, deliberate step with its own migration.
--
-- chip_order_card_sessions (new table) — every payment session THIS server
-- opened, one row each: the processor's session id, the order, the
-- environment, the moment. A charge is accepted for an order only when it
-- names a session recorded here for that order — the order number alone (the
-- more_info we send) never pays anything — and the lookup of an order asks the
-- processor about each of its recent sessions, not only the last one.

alter table public.chip_orders
  add column card_provider text,
  add column card_env text,
  add column card_status text,
  add column card_page_request_uid text,
  add column card_session_at timestamptz,
  add column card_transaction_uid text,
  add column card_paid_amount numeric(10,2),
  add column card_paid_at timestamptz,
  add column card_approval_number text,
  add column card_last4 text,
  add column card_failure_reason text,
  add column card_failed_at timestamptz;

alter table public.chip_orders
  add constraint chip_orders_card_provider_check
    check (card_provider is null or card_provider = 'payplus'),
  add constraint chip_orders_card_env_check
    check (card_env is null or card_env in ('sandbox', 'production')),
  add constraint chip_orders_card_status_check
    check (card_status is null or card_status in ('started', 'paid', 'failed')),
  -- No card state without a session we opened, and no session data without a state.
  add constraint chip_orders_card_session_check
    check (
      (card_status is null and card_provider is null and card_env is null
        and card_page_request_uid is null and card_session_at is null)
      or
      (card_status is not null and card_provider is not null and card_env is not null
        and card_page_request_uid is not null and card_session_at is not null)
    ),
  -- Paid: everything the processor confirmed, on an order that is no longer
  -- waiting, for exactly the order's total. Not paid: none of it.
  add constraint chip_orders_card_paid_check
    check (
      (card_status is not distinct from 'paid'
        and card_transaction_uid is not null and card_paid_at is not null
        and card_paid_amount is not null and card_paid_amount = total
        and status <> 'pending_payment')
      or
      (card_status is distinct from 'paid'
        and card_transaction_uid is null and card_paid_at is null and card_paid_amount is null
        and card_approval_number is null and card_last4 is null)
    ),
  add constraint chip_orders_card_last4_check
    check (card_last4 is null or card_last4 ~ '^[0-9]{4}$'),
  add constraint chip_orders_card_text_check
    check (
      (card_approval_number is null or length(card_approval_number) between 1 and 40)
      and (card_transaction_uid is null or length(card_transaction_uid) between 8 and 80)
      and (card_page_request_uid is null or length(card_page_request_uid) between 8 and 80)
    ),
  add constraint chip_orders_card_failure_check
    check (
      (card_failure_reason is null or length(card_failure_reason) between 1 and 300)
      and ((card_failure_reason is null) = (card_failed_at is null))
      and (card_failure_reason is null or card_status = 'failed')
      and (card_status is distinct from 'failed' or card_failure_reason is not null)
    ),
  -- The sandbox belongs to test orders only, production never to one.
  add constraint chip_orders_card_env_test_check
    check (
      (card_env is distinct from 'sandbox' or is_test)
      and (card_env is distinct from 'production' or not is_test)
    ),
  -- An order made at the reception is never paid by card here.
  add constraint chip_orders_card_web_check
    check (card_status is null or source = 'web');

create unique index chip_orders_card_transaction_uid_key
  on public.chip_orders (card_transaction_uid) where card_transaction_uid is not null;
create unique index chip_orders_card_page_request_uid_key
  on public.chip_orders (card_page_request_uid) where card_page_request_uid is not null;

create table public.chip_order_card_sessions (
  page_request_uid text primary key
    check (length(page_request_uid) between 8 and 80),
  order_id uuid not null references public.chip_orders(id) on delete cascade,
  env text not null check (env in ('sandbox', 'production')),
  created_at timestamptz not null default now()
);
create index chip_order_card_sessions_order_idx
  on public.chip_order_card_sessions (order_id, created_at desc);

comment on table public.chip_order_card_sessions is
  'Card payment sessions (PayPlus page requests) this server opened for chip orders. A charge counts for an order only when it names one of that order''s sessions.';

comment on column public.chip_orders.card_status is
  'Card payment (PayPlus hosted fields): started / paid / failed. NULL = no card session was ever opened for the order.';
comment on column public.chip_orders.card_env is
  'The processor environment of the card session. sandbox only on a test order, production never on one (chip_orders_card_env_test_check).';
comment on column public.chip_orders.card_last4 is
  'The last four digits of the card that paid. The card number, its expiry and the CVV are never stored.';

-- migrate:down
-- Refuses while a card payment is recorded: rolling back would lose what the
-- processor confirmed (transaction id, amount, approval number). Deleting that
-- is a human decision. A session that was only opened, or failed, is dropped.
do $$
begin
  if exists (select 1 from public.chip_orders where card_status = 'paid') then
    raise exception 'down refused: chip_orders holds card payments of 25/11/2026';
  end if;
end
$$;

drop table public.chip_order_card_sessions;

drop index if exists public.chip_orders_card_page_request_uid_key;
drop index if exists public.chip_orders_card_transaction_uid_key;

alter table public.chip_orders
  drop constraint chip_orders_card_web_check,
  drop constraint chip_orders_card_env_test_check,
  drop constraint chip_orders_card_failure_check,
  drop constraint chip_orders_card_text_check,
  drop constraint chip_orders_card_last4_check,
  drop constraint chip_orders_card_paid_check,
  drop constraint chip_orders_card_session_check,
  drop constraint chip_orders_card_status_check,
  drop constraint chip_orders_card_env_check,
  drop constraint chip_orders_card_provider_check,
  drop column card_failed_at,
  drop column card_failure_reason,
  drop column card_last4,
  drop column card_approval_number,
  drop column card_paid_at,
  drop column card_paid_amount,
  drop column card_transaction_uid,
  drop column card_session_at,
  drop column card_page_request_uid,
  drop column card_status,
  drop column card_env,
  drop column card_provider;
