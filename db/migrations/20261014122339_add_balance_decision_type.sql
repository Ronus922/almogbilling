-- migrate:up
-- Third document type for the existing decisions/protocols mechanism
-- (public.portal_decisions, 20261005210110): "מאזן" (balance sheet / annual
-- financial report PDF), read by the owners portal's new "מאזנים" tab —
-- replacing the "דוחות" tab it took the nav slot from. Additive only: same
-- table, same columns, the CHECK constraint widens to a third value. A
-- balance never carries decision_number, exactly like a protocol (enforced
-- in the application layer, same as today).
alter table public.portal_decisions
  drop constraint portal_decisions_doc_type_check;
alter table public.portal_decisions
  add constraint portal_decisions_doc_type_check
  check (doc_type in ('decision', 'protocol', 'balance'));

comment on column public.portal_decisions.doc_type is
  'decision = החלטה (may carry decision_number) · protocol = פרוטוקול · balance = מאזן (neither ever numbered on screen).';

-- migrate:down
-- Reversible only while no row uses the third value — the same discipline
-- dbmate expects of every down migration here.
alter table public.portal_decisions
  drop constraint portal_decisions_doc_type_check;
alter table public.portal_decisions
  add constraint portal_decisions_doc_type_check
  check (doc_type in ('decision', 'protocol'));

comment on column public.portal_decisions.doc_type is
  'decision = החלטה (may carry decision_number) · protocol = פרוטוקול (never numbered on screen).';
