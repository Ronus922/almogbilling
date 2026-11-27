-- migrate:up
-- "ביטול וזיכוי" of a reception order, and the email of Morning documents
-- (27/11/2026 — what the first real ₪1 charge of 26/11/2026 exposed;
-- docs/chip-orders.md "ביטול וזיכוי של הזמנת קבלה").
--
-- 1. chip_orders — the steps of "ביטול וזיכוי". The action runs, in this
--    order: the refund in PayPlus (a card), the credit document in Morning,
--    and the cancellation itself (the order `rejected`, its chips disabled).
--    When a step fails the order says which, and a retry runs the remaining
--    steps only (a refund that went through is never sent again):
--      cancel_requested_at / _by / _by_name / cancel_request_reason — who
--        started it, when, and why (the reason of every later step);
--      cancel_failed_step — 'refund' | 'credit' | 'cancel', with cancel_error
--        (the words shown on the order); null while it runs and once done;
--      cancel_running_until — a short lease: one run at a time per order.
--    (cancelled_by / cancelled_by_name stay what they were: set only by the
--    last step, with status `rejected` — chip_orders_cancelled_check.)
-- 2. chip_order_documents — whether Morning was asked to email the document:
--      email_status 'sent' (email_to = the address on the request — Morning
--      sends the download link to client.emails) or 'no_email' (the order had
--      no address: issued without one). Null on a row issued before this, or
--      found again in Morning after a crash (what it was sent to is unknown).
--
-- Only NEW NULLABLE columns: every existing row satisfies the new CHECKs, and
-- the code that ran before never writes them — `deploy:rollback` runs on this
-- schema. DOWN drops them (the steps of an unfinished "ביטול וזיכוי" are lost).

alter table public.chip_orders
  add column cancel_requested_at timestamptz,
  add column cancel_requested_by uuid references public.users(id) on delete set null,
  add column cancel_requested_by_name text,
  add column cancel_request_reason text,
  add column cancel_failed_step text,
  add column cancel_error text,
  add column cancel_running_until timestamptz;

alter table public.chip_orders add constraint chip_orders_cancel_request_check check (
  (cancel_requested_at is null
    and cancel_requested_by is null and cancel_requested_by_name is null and cancel_request_reason is null
    and cancel_failed_step is null and cancel_error is null and cancel_running_until is null)
  or (cancel_requested_at is not null and source = 'reception'
    and cancel_requested_by_name is not null and length(cancel_requested_by_name) <= 120
    and cancel_request_reason is not null and length(btrim(cancel_request_reason)) between 2 and 500)
);
alter table public.chip_orders add constraint chip_orders_cancel_step_check check (
  (cancel_failed_step is null or cancel_failed_step in ('refund', 'credit', 'cancel'))
  and (cancel_failed_step is null) = (cancel_error is null)
  and (cancel_error is null or length(cancel_error) between 1 and 500)
);

alter table public.chip_order_documents
  add column email_status text,
  add column email_to text;

alter table public.chip_order_documents add constraint chip_order_documents_email_check check (
  (email_status is null and email_to is null)
  or (email_status = 'no_email' and email_to is null)
  or (email_status = 'sent' and email_to is not null and length(email_to) between 3 and 254)
);

-- migrate:down
alter table public.chip_order_documents drop constraint chip_order_documents_email_check;
alter table public.chip_order_documents drop column email_to, drop column email_status;
alter table public.chip_orders drop constraint chip_orders_cancel_step_check;
alter table public.chip_orders drop constraint chip_orders_cancel_request_check;
alter table public.chip_orders
  drop column cancel_running_until,
  drop column cancel_error,
  drop column cancel_failed_step,
  drop column cancel_request_reason,
  drop column cancel_requested_by_name,
  drop column cancel_requested_by,
  drop column cancel_requested_at;
