-- migrate:up
-- Three notes of a chip order, each its own column (27/11/2026, Ronen —
-- docs/chip-orders.md, "שלוש הערות להזמנה"):
--   · orderer_note  — "הערת המזמין": what the orderer wrote in the notes field
--     of the public form. Until today it was stored in internal_note (the
--     staff's own note), so no screen but the issue window ever showed it.
--     Read only for the staff.
--   · guard_note    — "הערה לשומר": written by whoever prepares or issues the
--     chips (never the guard), until the order is handed over; who and when.
--   · delivery_note — "הערת מסירה": written by whoever hands the chips over
--     (the guard's "נמסר", or the staff's "נאסף"); who and when.
-- internal_note keeps its meaning (the staff's internal note, never shown to
-- the guard).
--
-- NEW NULLABLE columns and one check only: every existing row satisfies it,
-- and the code that ran before never writes them — `deploy:rollback` runs on
-- this schema (the old code writes the orderer's note into internal_note, as
-- before). No row is moved: there was no chip order in production when this
-- was written (the test orders of 27/11 were deleted before it). DOWN refuses
-- while any of the three notes holds text (it would be lost).

alter table public.chip_orders
  add column orderer_note text,
  add column guard_note text,
  add column guard_note_by uuid references public.users(id) on delete set null,
  add column guard_note_by_name text,
  add column guard_note_at timestamptz,
  add column delivery_note text,
  add column delivery_note_by uuid references public.users(id) on delete set null,
  add column delivery_note_by_name text,
  add column delivery_note_at timestamptz,
  -- Decision 3.5 (27/11/2026): the box "the details are correct and I accept
  -- the terms" is recorded like the renter's box, and the payment window of a
  -- web order opens only once it is (and the renter's, when a renter row exists).
  add column terms_accepted_at timestamptz;

alter table public.chip_orders add constraint chip_orders_notes_check check (
  (orderer_note is null or length(btrim(orderer_note)) between 1 and 500)
  and (guard_note is null or (length(btrim(guard_note)) between 1 and 500 and guard_note_at is not null))
  and ((guard_note_at is null) = (guard_note_by_name is null))
  and (guard_note_by_name is null or length(guard_note_by_name) <= 120)
  and (delivery_note is null or (length(btrim(delivery_note)) between 1 and 500 and delivery_note_at is not null))
  and ((delivery_note_at is null) = (delivery_note_by_name is null))
  and (delivery_note_by_name is null or length(delivery_note_by_name) <= 120)
);

comment on column public.chip_orders.orderer_note is 'הערת המזמין — the notes field of the public order form (27/11/2026). Read only for the staff; shown in the order window, the orders table, the reception window and the guard''s pickup screen.';
comment on column public.chip_orders.guard_note is 'הערה לשומר — written by the staff who prepare or issue the chips, until the order is handed over (27/11/2026). Shown on the guard''s pickup screen.';
comment on column public.chip_orders.delivery_note is 'הערת מסירה — written at the hand-over (the guard''s "נמסר" or the staff''s "נאסף", 27/11/2026).';

-- migrate:down
do $$
begin
  if exists (select 1 from public.chip_orders
              where orderer_note is not null or guard_note is not null or delivery_note is not null) then
    raise exception 'a chip order holds an orderer, guard or delivery note — it would be lost; refusing';
  end if;
end $$;
alter table public.chip_orders drop constraint chip_orders_notes_check;
alter table public.chip_orders
  drop column delivery_note_at,
  drop column delivery_note_by_name,
  drop column delivery_note_by,
  drop column delivery_note,
  drop column guard_note_at,
  drop column guard_note_by_name,
  drop column guard_note_by,
  drop column guard_note;
alter table public.chip_orders drop column orderer_note;
alter table public.chip_orders drop column terms_accepted_at;
