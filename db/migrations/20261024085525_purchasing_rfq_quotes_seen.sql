-- migrate:up
-- quotes_seen_at: one stamp per request ("someone opened it after the last
-- portal quote arrived") — not per user. A portal quote is "new" while its
-- submitted/updated time is later than this stamp.
-- due_notice_sent_at: dedupe of the "due date passed" notice (sent once).
alter table public.purchasing_documents
  add column quotes_seen_at timestamptz,
  add column due_notice_sent_at timestamptz;

-- Existing requests start with nothing new and nothing overdue to announce.
update public.purchasing_documents set quotes_seen_at = now() where doc_type = 'rfq';
update public.purchasing_documents set due_notice_sent_at = now()
 where doc_type = 'rfq' and due_date is not null and due_date < (now() at time zone 'Asia/Jerusalem')::date;

-- migrate:down
alter table public.purchasing_documents
  drop column due_notice_sent_at,
  drop column quotes_seen_at;
