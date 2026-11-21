-- migrate:up
-- Chip orders without an approval step (13/11/2026). A paid order now goes
-- straight to assigning chips inside the issue window, so "paid" means "being
-- assigned" and the due date runs from the payment, not from an approval.
--
-- Data only, nothing dropped:
--   1. Every order still in the legacy status 'approved' goes back to 'paid'.
--      Its approved_at stays as history, and its due_at stays as it was.
--   2. The CHECK keeps allowing 'approved', so a rollback build (which still
--      has the approve button) keeps working; nothing in the new code writes it.
--   3. Column comments say what approved_at / due_at mean from now on.

update public.chip_orders
   set status = 'paid', updated_at = now()
 where status = 'approved';

comment on column public.chip_orders.approved_at is
  'History only: when the approval step (removed 13/11/2026) approved the order. Never written since; a non-null value on a paid row marks an order approved before the change.';

comment on column public.chip_orders.due_at is
  '72 working hours (Sunday to Thursday, Israel time) from paid_at, set when the order is paid. Until 13/11/2026 it was set at the approval.';

-- migrate:down
-- Puts the orders that were approved back into 'approved' (approved_at marks
-- them), and removes the comments.

update public.chip_orders
   set status = 'approved', updated_at = now()
 where status = 'paid' and approved_at is not null;

comment on column public.chip_orders.approved_at is null;
comment on column public.chip_orders.due_at is null;
