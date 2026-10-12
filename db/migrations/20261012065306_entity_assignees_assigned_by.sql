-- migrate:up
alter table public.entity_assignees
  add column assigned_by uuid references public.users(id);

comment on column public.entity_assignees.assigned_by is
  'Actor who performed THIS assignment write (replaceEntityAssignees/copyEntityAssignees) — '
  'distinct from created_by, which the same functions also set to the same actor on every '
  'replace (delete-and-insert), so created_by does not preserve the original creator across '
  'reassignments. Added for the תקלות/משימות split-screens visibility rule (12/10/2026, '
  'Decisions Log): admin/manager see an item they assigned, even to someone else. NULL on '
  'every row written before this migration — those fall back to created_by/assignee only.';

create index entity_assignees_assigned_by_idx on public.entity_assignees (assigned_by)
  where assigned_by is not null;

-- migrate:down
drop index if exists public.entity_assignees_assigned_by_idx;
alter table public.entity_assignees drop column if exists assigned_by;

