-- 024_issues.sql
-- Module 2 — Issues (תקלות). Reuses Module 1's notifications + reminders
-- infrastructure (023). Tables: issues + issue_comments. Plus an ADDITIVE
-- column tasks.issue_id linking a task back to the issue it was created from.
--
-- ADDITIVE ONLY. Creates two new tables and adds ONE nullable column to the
-- existing tasks table (ADD COLUMN IF NOT EXISTS — no data touched). Idempotent
-- (IF NOT EXISTS / CREATE OR REPLACE) — safe to re-run. No data is deleted.
--
-- status / priority / location_type are text with CHECK constraints (project
-- convention — see tasks/statuses/import_runs — avoids hard pg ENUM migrations).
--
-- Run: psql "$DIRECT_URL" -f supabase/migrations/024_issues.sql

-- ─────────────────────────────────────────────────────────────────────────
-- 1. issues
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.issues (
  id                  uuid primary key default gen_random_uuid(),
  title               text not null,
  description         text,
  location_type       text not null default 'general'
                        check (location_type in ('apartment', 'area', 'general')),
  location_text       text,                       -- apartment number or area description
  priority            text not null default 'normal'
                        check (priority in ('low', 'normal', 'high', 'urgent')),
  status              text not null default 'open'
                        check (status in ('open', 'in_progress', 'resolved', 'closed')),
  assigned_to_user_id uuid references public.users(id) on delete set null,
  images              text[] not null default '{}',  -- storage object paths (not URLs)
  resolution_notes    text,
  resolved_at         timestamptz,
  is_archived         boolean not null default false,
  created_by          uuid references public.users(id) on delete set null,
  created_by_name     text,                       -- reporter snapshot
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists issues_status_idx       on public.issues (status);
create index if not exists issues_priority_idx      on public.issues (priority);
create index if not exists issues_assigned_to_idx   on public.issues (assigned_to_user_id);

drop trigger if exists issues_touch_updated_at on public.issues;
create trigger issues_touch_updated_at
  before update on public.issues
  for each row execute function public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────
-- 2. issue_comments
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.issue_comments (
  id           uuid primary key default gen_random_uuid(),
  issue_id     uuid not null references public.issues(id) on delete cascade,
  content      text not null,
  author_id    uuid references public.users(id) on delete set null,
  author_name  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists issue_comments_issue_id_idx on public.issue_comments (issue_id, created_at);

drop trigger if exists issue_comments_touch_updated_at on public.issue_comments;
create trigger issue_comments_touch_updated_at
  before update on public.issue_comments
  for each row execute function public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────
-- 3. tasks.issue_id — link a task to the issue it was created from (additive)
-- ─────────────────────────────────────────────────────────────────────────
alter table public.tasks
  add column if not exists issue_id uuid references public.issues(id) on delete set null;

create index if not exists tasks_issue_id_idx on public.tasks (issue_id);
