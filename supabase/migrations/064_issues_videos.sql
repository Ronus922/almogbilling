-- 064_issues_videos.sql
-- Issues media — add VIDEO attachments alongside the existing image attachments.
--
-- ADDITIVE ONLY. Adds ONE nullable-defaulted array column to the existing
-- public.issues table. No new tables, no constraints, no triggers, no indexes,
-- and ZERO change to the existing `images` column (or any other). Existing rows
-- receive '{}' automatically via the default → no backfill, no lock of note.
-- Idempotent (ADD COLUMN IF NOT EXISTS) — safe to re-run.
--
-- Mirrors `images text[]` exactly: stores storage object PATHS (not URLs) in the
-- same private `issue-attachments` bucket, guarded by isPathUnderIssue and served
-- only through /api/files/issue-attachments/<path>. A separate column (not a mix
-- into `images`) keeps the 6-image cap semantics intact and lets the carousel
-- render <img> vs <video> without sniffing extensions.
--
-- Run: psql "$DIRECT_URL" -f supabase/migrations/064_issues_videos.sql

-- UP
alter table public.issues
  add column if not exists videos text[] not null default '{}';  -- storage object paths (not URLs)

-- DOWN
-- alter table public.issues drop column if exists videos;
