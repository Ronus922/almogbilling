-- db/seed/e2e.sql — fixtures for the Playwright suite. TEST DATABASES ONLY,
-- never production. Idempotent (re-runnable).
--
-- Applied by scripts/e2e/seed.sh after `dbmate up`:
--   * e2e-admin — super_admin (every permission), password "E2e-Passw0rd!"
--     hashed here with pgcrypto's bcrypt ($2a$, verified by bcryptjs).
--   * one debtor, apartment E2E-101, with a fixed id the tests address directly.
--     Money fields are consistent (0 = 0 + 0) so check:money stays green.
--     phone_owner is a dummy Israeli mobile so the WhatsApp send sheet opens;
--     nothing is ever sent in the suite (no Green API instance is configured).
begin;

insert into public.users (username, email, password_hash, full_name, role, is_active)
values (
  'e2e-admin',
  'e2e-admin@billing.local',
  crypt('E2e-Passw0rd!', gen_salt('bf', 10)),
  'E2E Admin',
  'super_admin',
  true
)
on conflict (username) do nothing;

insert into public.debtors (id, apartment_number, owner_name, tenant_name, phone_owner, total_debt, management_fees, hot_water_debt, special_debt, is_archived)
values (
  '00000000-0000-4000-8000-0000000e2e01',
  'E2E-101',
  'דייר בדיקה',
  null,
  '050-0000000',
  0, 0, 0, 0,
  false
)
on conflict (id) do update set phone_owner = excluded.phone_owner;

commit;

-- ── Owners portal fixtures (28/09/2026) — e2e/portal-security.spec.ts ─────
-- Four apartments: A (debt, two owners, a disabled owner, a tenant phone),
-- B (hot-water debt), C (no debt), D (archived with a balance, shown like any
-- other — decision 28/09/2026; its figures carry agorot for the rounding
-- checks of e2e/portal-numbers.spec.ts). Every field a resident must never
-- see carries a CANARY-… value the spec greps for.
-- Live portal sessions for the owners (raw token → sha256, like the app),
-- one expired and one revoked. Two finance months: the previous month
-- published (with a receipt and a bank balance), the current one hidden with
-- a supplier, an invoice, an internal note, a receipt and a bank balance.
-- One-time codes with a known digit string ("123456", bcrypt) for the OTP
-- checks. Idempotent: every insert is guarded.
begin;

-- The owners come from the apartments' OWNER RECORDS — the owner field, and an
-- extra owner on the card — exactly as in production: since 20261003095149
-- the roster MIRRORS those records at COMMIT, and a roster row with no record
-- behind it is switched off. (Inserting the rows straight into the roster,
-- as this seed did before phase C, left every fixture owner inactive on a
-- fresh database.) The roster insert below stays for idempotency and for the
-- one row that must exist switched off.
insert into public.contacts (apartment_number, tenant_phone, owner_name, owner_phone)
select v.a, v.t, v.n, v.p from (values
  ('E2E-A', '050-6666666', 'דנה E2E', '+972501111111'),
  ('E2E-B', null, 'בני E2E', '+972502222222'),
  ('E2E-C', null, 'גלית E2E', '+972503333333'),
  ('E2E-D', null, 'דוד E2E', '+972504444444')
) v(a, t, n, p)
on conflict (apartment_number) do update
  set owner_name = excluded.owner_name, owner_phone = excluded.owner_phone;

-- A tenant and an operator (03/10/2026, the portal by role), through the card
-- exactly like the owners: E2E-T's card says a tenant lives there (resident
-- type 'tenant'), E2E-O's says an operator runs it ('operator') — the section
-- the card SHOWS is what links. E2E-A's tenant phone above sits in a section
-- its card hides (resident type 'owner'), so it opens nothing.
insert into public.contacts (apartment_number, owner_name, resident_type, tenant_name, tenant_phone)
select v.a, v.o, v.rt, v.n, v.p from (values
  ('E2E-T', 'בעלים T E2E', 'tenant',   'טל שוכרת E2E', '+972507777777'),
  ('E2E-O', 'בעלים O E2E', 'operator', 'עומר מפעיל E2E', '+972508888888')
) v(a, o, rt, n, p)
on conflict (apartment_number) do update
  set resident_type = excluded.resident_type, tenant_name = excluded.tenant_name, tenant_phone = excluded.tenant_phone;

-- The second owner of A and of B: an extra owner on the card.
insert into public.contact_people (contact_id, role, name, phone, sort_order)
select c.id, 'owner', v.n, v.p, 0
  from (values ('E2E-A', 'יוסי E2E', '+972501111112'),
               ('E2E-B', 'רותי E2E', '+972502222223')) v(a, n, p)
  join public.contacts c on c.apartment_number = v.a
 where not exists (select 1 from public.contact_people x
                    where x.contact_id = c.id and x.role = 'owner' and x.phone = v.p);

insert into public.debtors (id, apartment_number, owner_name, phone_owner, email_owner, total_debt, management_fees, hot_water_debt, special_debt, monthly_debt, details, is_archived, notes, next_action_description, legal_status_updated_by_name)
values
  ('00000000-0000-4000-8000-0000000e2e0a', 'E2E-A', 'CANARY-OWNER-A', '050-1111111', 'canary-a@example.com', 1240, 840, 400, 0, '3/26', E'מים חמים 01-03/26 <script>window.__pwned=1</script>', false, 'CANARY-NOTE-A', 'CANARY-ACTION-A', 'CANARY-LEGAL-A'),
  ('00000000-0000-4000-8000-0000000e2e0b', 'E2E-B', 'CANARY-OWNER-B', '050-2222222', 'canary-b@example.com', 300, 0, 300, 0, '1/26', 'מים חמים 02/26', false, 'CANARY-NOTE-B', 'CANARY-ACTION-B', 'CANARY-LEGAL-B'),
  ('00000000-0000-4000-8000-0000000e2e0c', 'E2E-C', 'CANARY-OWNER-C', '050-3333333', null, 0, 0, 0, 0, null, null, false, 'CANARY-NOTE-C', null, null),
  ('00000000-0000-4000-8000-0000000e2e0d', 'E2E-D', 'CANARY-OWNER-D', '050-4444444', null, 999.5, 999.5, 0, 0, '9/26', 'E2E-DETAILS-D מים חמים 07-09/26', true, 'CANARY-NOTE-D', 'CANARY-ACTION-D', 'CANARY-LEGAL-D'),
  ('00000000-0000-4000-8000-0000000e2e0e', 'E2E-T', 'CANARY-OWNER-T', '0507070707', null, 500, 500, 0, 0, '2/26', null, false, 'CANARY-NOTE-T', null, null),
  ('00000000-0000-4000-8000-0000000e2e0f', 'E2E-O', 'CANARY-OWNER-O', '0508080808', null, 0, 0, 0, 0, null, null, false, 'CANARY-NOTE-O', null, null)
on conflict (id) do update set total_debt = excluded.total_debt, management_fees = excluded.management_fees, hot_water_debt = excluded.hot_water_debt, monthly_debt = excluded.monthly_debt, details = excluded.details, is_archived = excluded.is_archived, notes = excluded.notes;

insert into public.apartment_owner_phones (apartment_number, owner_name, phone_e164, is_active)
select v.a, v.n, v.p, v.act from (values
  ('E2E-A', 'דנה E2E', '+972501111111', true),
  ('E2E-A', 'יוסי E2E', '+972501111112', true),
  ('E2E-A', 'CANARY-DISABLED', '+972505555555', false),
  ('E2E-B', 'בני E2E', '+972502222222', true),
  -- A second owner on B, so e2e/portal-login-otp.spec.ts can give every test a
  -- phone of its own: the 45-second resend cooldown means a number that has
  -- just been sent a code cannot be sent another inside one run.
  ('E2E-B', 'רותי E2E', '+972502222223', true),
  ('E2E-C', 'גלית E2E', '+972503333333', true),
  ('E2E-D', 'דוד E2E', '+972504444444', true)
) v(a, n, p, act)
on conflict (apartment_number, phone_e164) do nothing;

-- sessions: raw tokens e2e-owner-a1 · e2e-owner-a2 · e2e-owner-b · e2e-owner-c · e2e-owner-d · e2e-owner-disabled · e2e-expired (A1, past) · e2e-revoked (A1, revoked)
insert into public.portal_sessions (token_hash, phone_e164, expires_at, revoked_at)
select encode(digest(v.tok, 'sha256'), 'hex'), v.p, v.exp, v.rev from (values
  ('e2e-owner-a1',       '+972501111111', now() + interval '12 hours', null::timestamptz),
  ('e2e-owner-a2',       '+972501111112', now() + interval '12 hours', null),
  ('e2e-owner-b',        '+972502222222', now() + interval '12 hours', null),
  ('e2e-owner-c',        '+972503333333', now() + interval '12 hours', null),
  ('e2e-owner-d',        '+972504444444', now() + interval '12 hours', null),
  ('e2e-owner-disabled', '+972505555555', now() + interval '12 hours', null),
  ('e2e-tenant-t',       '+972507777777', now() + interval '12 hours', null),
  ('e2e-operator-o',     '+972508888888', now() + interval '12 hours', null),
  ('e2e-expired',        '+972501111111', now() - interval '1 hour',   null),
  ('e2e-revoked',        '+972501111111', now() + interval '12 hours', now())
) v(tok, p, exp, rev)
where not exists (select 1 from public.portal_sessions s where s.token_hash = encode(digest(v.tok, 'sha256'), 'hex'));

-- one-time codes: "123456" for B (lockout ladder), C (happy path + reuse), D (expired)
insert into public.portal_otp_codes (phone_e164, code_hash, expires_at)
select v.p, crypt('123456', gen_salt('bf', 10)), v.exp from (values
  ('+972502222222', now() + interval '2 hours'),
  ('+972503333333', now() + interval '2 hours'),
  ('+972504444444', now() - interval '1 minute')
) v(p, exp)
where not exists (select 1 from public.portal_otp_codes c where c.phone_e164 = v.p);

-- finance: categories, two months (previous = published, current = hidden).
-- The published month's amounts carry agorot (8,820.40 + 1 in, 1,800.50 out)
-- so the screen's whole shekels (₪8,821 / ₪1,801 / ₪7,021) and the export's
-- exact numbers can both be checked; the fund holds one income and one
-- expense of the same month for the fund tab's rounding and colours.
insert into public.fin_categories (id, kind, name, sort_order, section) values
  ('e2e00000-0000-4000-8000-0000000000c1', 'income',  'E2E דמי ועד', 90, 'operating'),
  ('e2e00000-0000-4000-8000-0000000000c2', 'expense', 'E2E ניקיון', 90, 'operating'),
  ('e2e00000-0000-4000-8000-0000000000c3', 'income',  'E2E תשלום לקרן', 90, 'renovation_fund'),
  ('e2e00000-0000-4000-8000-0000000000c4', 'expense', 'E2E זיפות גג', 90, 'renovation_fund')
on conflict (id) do nothing;

insert into public.fin_entries (id, kind, category_id, period_month, amount, description, supplier_name, invoice_number, internal_note, payment_date)
values
  ('e2e00000-0000-4000-8000-0000000000e1', 'income',  'e2e00000-0000-4000-8000-0000000000c1', date_trunc('month', now() - interval '1 month')::date, 8820.4, 'E2E דמי ועד <script>window.__pwned=1</script>', '', '', 'CANARY-INTERNAL-PUB', null),
  ('e2e00000-0000-4000-8000-0000000000e2', 'expense', 'e2e00000-0000-4000-8000-0000000000c2', date_trunc('month', now() - interval '1 month')::date, 1800.5, 'E2E ניקיון חדר מדרגות', 'CANARY-SUPPLIER-PUB', 'CANARY-INVOICE-PUB', 'CANARY-INTERNAL-PUB', (date_trunc('month', now() - interval '1 month') + interval '14 days')::date),
  ('e2e00000-0000-4000-8000-0000000000e3', 'expense', 'e2e00000-0000-4000-8000-0000000000c2', date_trunc('month', now())::date, 6543.21, 'CANARY-HIDDEN-ENTRY', 'CANARY-SUPPLIER-HIDDEN', 'CANARY-INVOICE-HIDDEN', 'CANARY-INTERNAL-HIDDEN', (date_trunc('month', now()) + interval '2 days')::date),
  ('e2e00000-0000-4000-8000-0000000000e4', 'income',  'e2e00000-0000-4000-8000-0000000000c1', date_trunc('month', now() - interval '1 month')::date, 1, '=1+1 E2E-FORMULA', '', '', '', null),
  ('e2e00000-0000-4000-8000-0000000000e5', 'income',  'e2e00000-0000-4000-8000-0000000000c3', date_trunc('month', now() - interval '1 month')::date, 5000.5, 'E2E קרן — גבייה', '', '', '', null),
  ('e2e00000-0000-4000-8000-0000000000e6', 'expense', 'e2e00000-0000-4000-8000-0000000000c4', date_trunc('month', now() - interval '1 month')::date, 1200.25, 'E2E קרן — זיפות', 'CANARY-SUPPLIER-FUND', '', 'CANARY-INTERNAL-FUND', (date_trunc('month', now() - interval '1 month') + interval '9 days')::date)
on conflict (id) do update set amount = excluded.amount, description = excluded.description;

-- a staff user WITHOUT the finance module (viewer: debtors screen only) — the admin-preview gate check
insert into public.users (username, email, password_hash, full_name, role, is_active)
values ('e2e-viewer', 'e2e-viewer@billing.local', crypt('E2e-Viewer0!', gen_salt('bf', 10)), 'E2E Viewer', 'viewer', true)
on conflict (username) do nothing;

insert into public.fin_documents (id, entry_id, object_key, original_name, mime, size) values
  ('e2e00000-0000-4000-8000-0000000000d1', 'e2e00000-0000-4000-8000-0000000000e2', 'e2e00000-0000-4000-8000-0000000000bb.pdf', 'E2E-קבלה-מפורסם.pdf', 'application/pdf', 100),
  ('e2e00000-0000-4000-8000-0000000000d2', 'e2e00000-0000-4000-8000-0000000000e3', 'e2e00000-0000-4000-8000-0000000000aa.pdf', 'CANARY-RECEIPT-HIDDEN.pdf', 'application/pdf', 100)
on conflict (id) do nothing;

insert into public.finance_month_status (year, month, published, bank_balance)
select v.y, v.m, v.p, v.b from (values
  (extract(year from now() - interval '2 months')::int, extract(month from now() - interval '2 months')::int, true,  46180::numeric),
  (extract(year from now() - interval '1 month')::int,  extract(month from now() - interval '1 month')::int,  true,  48320::numeric),
  (extract(year from now())::int,                       extract(month from now())::int,                       false, 7654321::numeric)
) v(y, m, p, b)
on conflict (year, month) do update set published = excluded.published, bank_balance = excluded.bank_balance;

insert into public.fin_settings (id, show_documents_to_residents, show_bank_balance_to_residents)
values (1, false, false)
on conflict (id) do update set show_documents_to_residents = false, show_bank_balance_to_residents = false;

commit;
