-- 051_chat_messages_supplier.sql
-- WhatsApp conversations → supplier link. A conversation is linked to a debtor
-- (apartment), a supplier (external contractor), or is unlinked — never to both.
-- The link KIND is DERIVED from which column is populated (debtor_id → דירה,
-- supplier_id → ספק, both null → unlinked); no redundant `type` column. XOR is
-- enforced in the app layer (linking to a supplier clears debtor_id and vice
-- versa) — see src/lib/whatsapp-link.ts (normalizeChatLink).
--
-- Additive only: one nullable column + FK + index. The existing debtor_id /
-- link_status columns are untouched. FK is ON DELETE SET NULL so deleting a
-- supplier never deletes messages — it only detaches the conversation (the row
-- then derives as unlinked, since debtor_id was cleared at supplier-link time).
--
-- Run: docker exec -i supabase-db psql -U postgres -d proj_billing < supabase/migrations/051_chat_messages_supplier.sql

begin;

alter table public.chat_messages
  add column if not exists supplier_id uuid
    references public.suppliers(id) on delete set null;

create index if not exists idx_chat_messages_supplier on public.chat_messages (supplier_id);

commit;
