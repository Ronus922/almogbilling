-- migrate:up
-- Chip orders: refunds through PayPlus (26/11/2026, night run —
-- docs/chip-orders.md "זיכויים").
--
-- Additive: new NULLABLE columns on chip_orders and two CHECKs that are
-- REPLACED BY WIDER ONES (every existing row satisfies both; the code that ran
-- before writes nothing the new rules refuse).
--
--   refund_requested_at   a refund was sent to PayPlus and its answer is not
--                         recorded yet (cleared with the answer) — a second
--                         refund of the same order is refused meanwhile.
--   refunded_at           when the refund was confirmed.
--   refunded_amount       how much went back (≤ what was charged).
--   refund_transaction_uid  PayPlus's id of the refund (of the first one).
--   refunded_by / refunded_by_name  who pressed "זיכוי" (NULL for a refund
--                         made in the PayPlus dashboard and reported to us).
--   refund_via            'admin' ("זיכוי" in the order window), 'reject'
--                         ("דחה"), 'reception_cancel' ("בטל הזמנת קבלה"),
--                         'payplus' (made in the PayPlus dashboard).
--   refund_reason         the reason typed with "זיכוי" (an order that was
--                         already collected keeps its status; the reason
--                         lives here).
--
-- chip_orders_refund_status_check gains 'partial' (a refund in the PayPlus
-- dashboard of part of the charge). chip_order_notifications_kind_check gains
-- 'refunded' (the customer's message when an order is refunded).

alter table public.chip_orders
  add column refund_requested_at timestamptz,
  add column refunded_at timestamptz,
  add column refunded_amount numeric(10,2),
  add column refund_transaction_uid text,
  add column refunded_by uuid,
  add column refunded_by_name text,
  add column refund_via text,
  add column refund_reason text;

alter table public.chip_orders
  add constraint chip_orders_refund_via_check check (refund_via is null or refund_via in ('admin', 'reject', 'reception_cancel', 'payplus')),
  add constraint chip_orders_refund_amount_check check (
    refunded_amount is null or (refunded_amount > 0 and refunded_amount <= total)
  ),
  -- NULL-safe: a refund on record always says whether it was full or partial.
  add constraint chip_orders_refunded_check check (
    (refunded_at is null) = (refunded_amount is null)
    and (refunded_at is null or coalesce(refund_status in ('refunded', 'partial'), false))
    and (refunded_by_name is null or refunded_at is not null)
  ),
  add constraint chip_orders_refund_text_check check (
    (refund_reason is null or length(btrim(refund_reason)) between 2 and 500)
    and (refunded_by_name is null or length(refunded_by_name) <= 120)
    and (refund_transaction_uid is null or length(refund_transaction_uid) between 8 and 80)
  );

create unique index chip_orders_refund_tx_key on public.chip_orders (refund_transaction_uid)
  where refund_transaction_uid is not null;

alter table public.chip_orders drop constraint chip_orders_refund_status_check;
alter table public.chip_orders add constraint chip_orders_refund_status_check check (
  refund_status is null or refund_status in ('refunded', 'manual_required', 'not_required', 'partial')
);

alter table public.chip_order_notifications drop constraint chip_order_notifications_kind_check;
alter table public.chip_order_notifications add constraint chip_order_notifications_kind_check check (
  kind in ('paid', 'approved', 'ready', 'rejected', 'refunded')
);

comment on column public.chip_orders.refund_via is
  'Where the refund came from: admin ("זיכוי"), reject ("דחה"), reception_cancel ("בטל הזמנת קבלה"), payplus (made in the PayPlus dashboard, reported by its callback).';

-- migrate:down
do $$
begin
  if exists (select 1 from public.chip_orders where refunded_at is not null or refund_requested_at is not null or refund_via is not null or refund_status = 'partial') then
    raise exception 'chip_order_refunds down: refunds are recorded — refusing';
  end if;
  if exists (select 1 from public.chip_order_notifications where kind = 'refunded') then
    raise exception 'chip_order_refunds down: "refunded" messages are recorded — refusing';
  end if;
end $$;

alter table public.chip_order_notifications drop constraint chip_order_notifications_kind_check;
alter table public.chip_order_notifications add constraint chip_order_notifications_kind_check check (
  kind in ('paid', 'approved', 'ready', 'rejected')
);
alter table public.chip_orders drop constraint chip_orders_refund_status_check;
alter table public.chip_orders add constraint chip_orders_refund_status_check check (
  refund_status is null or refund_status in ('refunded', 'manual_required', 'not_required')
);
drop index public.chip_orders_refund_tx_key;
alter table public.chip_orders
  drop constraint chip_orders_refund_text_check,
  drop constraint chip_orders_refunded_check,
  drop constraint chip_orders_refund_amount_check,
  drop constraint chip_orders_refund_via_check;
alter table public.chip_orders
  drop column refund_reason,
  drop column refund_via,
  drop column refunded_by_name,
  drop column refunded_by,
  drop column refund_transaction_uid,
  drop column refunded_amount,
  drop column refunded_at,
  drop column refund_requested_at;
