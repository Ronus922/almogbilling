-- migrate:up
-- A portal report's apartment: NULL when — and only when — the reporter is
-- unidentified (phase C, approved 03/10/2026, decision 6 of the audit).
--
-- Since the containment of 03/10/2026 a phone whose apartments belong to
-- different people still reports a fault, recorded as "לא מזוהה" with no
-- apartment and no roster link (reporter_contact_id NULL). The CHECK of
-- 20261003074737 demanded a non-null reporter_apartment on every portal row,
-- so the containment (code only, no migration) stored '' instead. Ronen
-- approved replacing the CHECK — the ONE non-additive change of phase C:
--   • identified reporter (reporter_contact_id set) → an apartment is required;
--   • unidentified (reporter_contact_id NULL)       → NULL is allowed;
--   • '' is never an apartment.
-- Existing '' rows become NULL in the same migration.
--
-- The title of a portal report changes from "תקלה בשטח משותף: <מיקום>" to
-- "דיווח דייר · <מיקום>" (lib/portal/issueReport.ts); existing portal rows
-- whose title is still the generated one are renamed here, the rest (a title
-- staff edited) are left alone.

alter table public.issues drop constraint issues_portal_reporter_check;

update public.issues
   set reporter_apartment = null
 where source = 'portal'
   and reporter_apartment is not null
   and btrim(reporter_apartment) = '';

alter table public.issues
  add constraint issues_portal_reporter_check check (
    source <> 'portal'
    or (
      reporter_phone is not null
      and reporter_location is not null
      and ticket_number is not null
      and (reporter_apartment is null or btrim(reporter_apartment) <> '')
      and (reporter_contact_id is null or reporter_apartment is not null)
    )
  );

comment on constraint issues_portal_reporter_check on public.issues is
  'Portal rows carry the reporter snapshot. reporter_apartment may be NULL only for an unidentified reporter (reporter_contact_id NULL — a phone whose apartments belong to different people); never ''''.';

update public.issues
   set title = 'דיווח דייר · ' || reporter_location
 where source = 'portal'
   and reporter_location is not null
   and title = 'תקלה בשטח משותף: ' || reporter_location;

-- migrate:down
update public.issues
   set title = 'תקלה בשטח משותף: ' || reporter_location
 where source = 'portal'
   and reporter_location is not null
   and title = 'דיווח דייר · ' || reporter_location;

alter table public.issues drop constraint issues_portal_reporter_check;

-- The old CHECK has no room for NULL: an unidentified reporter goes back to ''.
update public.issues
   set reporter_apartment = ''
 where source = 'portal'
   and reporter_apartment is null;

alter table public.issues
  add constraint issues_portal_reporter_check check (
    source <> 'portal'
    or (reporter_phone is not null and reporter_apartment is not null
        and reporter_location is not null and ticket_number is not null)
  );
