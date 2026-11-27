-- migrate:up
-- One way back for every card order, and the cancellations PayPlus reports
-- (27/11/2026 — docs/chip-orders.md "ביטול וזיכוי").
--
-- 1. "ביטול וזיכוי" runs for a WEB order too (it replaces "זיכוי"; "דחה" of
--    an order the card paid runs the same steps): the steps of migration
--    20261126220000 (cancel_requested_*, cancel_failed_step / cancel_error,
--    cancel_running_until) are no longer limited to a reception order.
--    cancel_completed_at — when the last step finished (the order is then
--    `rejected`, or still `collected`: a web order that was handed over keeps
--    that status, refunded, its chips disabled): nothing is left to run, and
--    the action is not offered again.
-- 2. payplus_reversal_at / payplus_reversal_kind — a signed PayPlus callback
--    for an order that was ALREADY paid, after which PayPlus itself (asked at
--    once, read only) shows the charge cancelled ('cancelled'), refunded in
--    full ('refunded') or in part ('partial') while the order records no such
--    refund. Nothing is recorded and no Morning document is issued for it:
--    the order carries the warning "בוטל ב-PayPlus — נדרש ביטול וזיכוי" until
--    an admin runs "ביטול וזיכוי" (which finds the cancellation in PayPlus,
--    sends no refund, issues the credit and closes the order — and clears it).
--
-- Only a RELAXED check and NEW NULLABLE columns: every existing row satisfies
-- them, and the code that ran before never writes them — `deploy:rollback`
-- runs on this schema. DOWN: the steps of a web order's run are cleared first
-- (the strict check comes back), then the new columns are dropped.

alter table public.chip_orders drop constraint chip_orders_cancel_request_check;
alter table public.chip_orders add constraint chip_orders_cancel_request_check check (
  (cancel_requested_at is null
    and cancel_requested_by is null and cancel_requested_by_name is null and cancel_request_reason is null
    and cancel_failed_step is null and cancel_error is null and cancel_running_until is null)
  or (cancel_requested_at is not null
    and cancel_requested_by_name is not null and length(cancel_requested_by_name) <= 120
    and cancel_request_reason is not null and length(btrim(cancel_request_reason)) between 2 and 500)
);

alter table public.chip_orders
  add column cancel_completed_at timestamptz,
  add column payplus_reversal_at timestamptz,
  add column payplus_reversal_kind text;

alter table public.chip_orders add constraint chip_orders_cancel_completed_check check (
  cancel_completed_at is null
  or (cancel_requested_at is not null and status in ('rejected', 'collected') and cancel_failed_step is null)
);
alter table public.chip_orders add constraint chip_orders_payplus_reversal_check check (
  (payplus_reversal_at is null) = (payplus_reversal_kind is null)
  and (payplus_reversal_kind is null or payplus_reversal_kind in ('cancelled', 'refunded', 'partial'))
  and (payplus_reversal_at is null or card_status = 'paid')
);

-- migrate:down
alter table public.chip_orders drop constraint chip_orders_payplus_reversal_check;
alter table public.chip_orders drop constraint chip_orders_cancel_completed_check;
alter table public.chip_orders
  drop column payplus_reversal_kind,
  drop column payplus_reversal_at,
  drop column cancel_completed_at;
update public.chip_orders
   set cancel_requested_at = null, cancel_requested_by = null, cancel_requested_by_name = null,
       cancel_request_reason = null, cancel_failed_step = null, cancel_error = null, cancel_running_until = null
 where source <> 'reception' and cancel_requested_at is not null;
alter table public.chip_orders drop constraint chip_orders_cancel_request_check;
alter table public.chip_orders add constraint chip_orders_cancel_request_check check (
  (cancel_requested_at is null
    and cancel_requested_by is null and cancel_requested_by_name is null and cancel_request_reason is null
    and cancel_failed_step is null and cancel_error is null and cancel_running_until is null)
  or (cancel_requested_at is not null and source = 'reception'
    and cancel_requested_by_name is not null and length(cancel_requested_by_name) <= 120
    and cancel_request_reason is not null and length(btrim(cancel_request_reason)) between 2 and 500)
);
