-- migrate:up
-- "סריקת כניסה" — the weight of the stored photo (09/11/2026).
--
-- The photo is now a progressive JPEG of at most ~300KB (a ladder of quality 82→64, then
-- 1280px, never below either: readability before weight; JPEG so that it opens on any
-- computer and can be handed to outside parties). image_bytes records the FINAL size
-- of each stored object so the weight can be followed over time with plain SQL.
--
-- Additive: one nullable column. Rows saved before this change keep NULL (their
-- objects are the old JPEGs; nothing is backfilled and nothing is rewritten).

alter table public.visitor_scans add column image_bytes integer;
comment on column public.visitor_scans.image_bytes is 'Size in bytes of the stored photo (image_object_key); NULL for rows saved before 09/11/2026.';

-- migrate:down
-- Dropping the column loses only the weights; the photos and the rows are untouched.
alter table public.visitor_scans drop column image_bytes;
