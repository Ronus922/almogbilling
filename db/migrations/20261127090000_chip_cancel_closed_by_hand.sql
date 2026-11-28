-- migrate:up
-- "סגירה ידנית" of a stuck "ביטול וזיכוי" (27/11/2026 — docs/chip-orders.md).
--
-- A run of "ביטול וזיכוי" can stop for good: Morning keeps refusing the credit
-- document (cancel_failed_step 'credit'), or the refund step cannot settle —
-- a refund call got no answer and PayPlus does not show it, or PayPlus shows
-- more than one charge for the order (cancel_failed_step 'refund' with
-- refund_status 'manual_required' and no refund recorded). A SUPER ADMIN may
-- then close the order by hand, with a reason: nothing is sent to PayPlus or
-- Morning, the order is cancelled and its chips disabled, the documents of the
-- order still waiting are stopped, and the order keeps for good who closed it,
-- when, why, and at which step (closed_by_hand_*). It is audited
-- ('cancel_closed_by_hand').
--
-- NEW NULLABLE columns and one check only: every existing row satisfies it,
-- and the code that ran before never writes them — `deploy:rollback` runs on
-- this schema. DOWN refuses while an order closed by hand exists (its mark
-- would be lost).

alter table public.chip_orders
  add column closed_by_hand_at timestamptz,
  add column closed_by_hand_by uuid references public.users(id) on delete set null,
  add column closed_by_hand_by_name text,
  add column closed_by_hand_reason text,
  add column closed_by_hand_step text;

alter table public.chip_orders add constraint chip_orders_closed_by_hand_check check (
  (closed_by_hand_at is null and closed_by_hand_by is null and closed_by_hand_by_name is null
    and closed_by_hand_reason is null and closed_by_hand_step is null)
  or (closed_by_hand_at is not null and cancel_completed_at is not null
    and closed_by_hand_by_name is not null and length(closed_by_hand_by_name) <= 120
    and closed_by_hand_reason is not null and length(btrim(closed_by_hand_reason)) between 2 and 500
    and closed_by_hand_step in ('refund', 'credit'))
);

-- migrate:down
do $$
begin
  if exists (select 1 from public.chip_orders where closed_by_hand_at is not null) then
    raise exception 'an order was closed by hand (closed_by_hand_at) — its mark would be lost; refusing';
  end if;
end $$;
alter table public.chip_orders drop constraint chip_orders_closed_by_hand_check;
alter table public.chip_orders
  drop column closed_by_hand_step,
  drop column closed_by_hand_reason,
  drop column closed_by_hand_by_name,
  drop column closed_by_hand_by,
  drop column closed_by_hand_at;
