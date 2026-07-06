-- 060 — chat_messages attachment metadata (additive)
-- Outbound messages sent from the debtor card can now carry a single file
-- attachment (jpg/png/webp/pdf/docx/xlsx). The file URL already lives in the
-- existing media_url column (public whatsapp-media bucket, reachable by Green
-- API's sendFileByUrl); these three columns add the metadata media_url alone
-- can't hold: the ORIGINAL (Hebrew) file name, its MIME type, and byte size —
-- so the debtor history can render a labelled, icon-by-type download row.
-- Purely additive: three nullable columns, no existing data touched.

alter table public.chat_messages
  add column if not exists attachment_name text,
  add column if not exists attachment_mime text,
  add column if not exists attachment_size int;
