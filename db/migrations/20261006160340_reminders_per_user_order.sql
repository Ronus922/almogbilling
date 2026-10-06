-- migrate:up
-- Per-user order of the reminders list (06/10/2026, Ronen's decision on the
-- 06/10 HARD STOP: per-user, not global).
--
-- One reminder is shown to two people — its creator under "שלי", its assignee
-- under "משותף איתי" — so an order kept on the reminder row itself would let
-- one of them rearrange the other's list. The order therefore lives beside the
-- reminder, one row per (user, reminder): dragging writes the dragging user's
-- rows alone, the other person's list does not move. A reminder with no row
-- for a user sorts after the ones that have one, by remind_at as before.
--
-- Both references cascade: a deleted reminder takes its order rows with it,
-- a deleted user (the permanent deletion of 06/10) takes theirs — nothing to
-- clear by hand in either path. (user_id, reminder_id) is the primary key, so
-- the pair is unique; the (user_id, position) index serves the list's sort.
--
-- Additive: one new table. No GRANT, no RLS (one service pool, src/lib/db.ts)
-- — the module permission and the "involved in this reminder" rule are
-- enforced by the route (PUT /api/user-reminders/order).

create table public.user_reminder_order (
  user_id     uuid    not null references public.users(id)          on delete cascade,
  reminder_id uuid    not null references public.user_reminders(id) on delete cascade,
  position    integer not null,
  primary key (user_id, reminder_id)
);

create index user_reminder_order_user_position_idx
  on public.user_reminder_order (user_id, position);

comment on table public.user_reminder_order is
  'Where each user placed each reminder in their own list (drag order, 06/10/2026). Per user: one person''s drag never moves another''s list. No row = after every placed one, by remind_at.';
comment on column public.user_reminder_order.position is
  'Ascending place in that user''s list; rewritten 0..n-1 for the ids of the tab the user dragged in.';

-- migrate:down
drop table if exists public.user_reminder_order;
