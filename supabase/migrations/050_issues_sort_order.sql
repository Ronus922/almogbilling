-- 050 — issues.sort_order (additive)
-- Gives issues the same manual kanban ordering tasks already have (migration 023
-- added it to public.tasks). Purely additive: a new integer column defaulting to 0
-- plus a (status, sort_order) index for the board query. No data is touched; the
-- column is backfilled to 0 for every existing row, after which the kanban
-- renumbers it per drag via /api/issues/reorder.

alter table public.issues
  add column if not exists sort_order integer not null default 0;

create index if not exists issues_status_sort_idx
  on public.issues (status, sort_order);
