-- db/seed/e2e.sql — fixtures for the Playwright suite. TEST DATABASES ONLY,
-- never production. Idempotent (re-runnable).
--
-- Applied by scripts/e2e/seed.sh after `dbmate up`:
--   * e2e-admin — super_admin (every permission), password "E2e-Passw0rd!"
--     hashed here with pgcrypto's bcrypt ($2a$, verified by bcryptjs).
--   * one debtor, apartment E2E-101, with a fixed id the tests address directly.
--     Money fields are consistent (0 = 0 + 0) so check:money stays green.
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

insert into public.debtors (id, apartment_number, owner_name, tenant_name, total_debt, management_fees, hot_water_debt, special_debt, is_archived)
values (
  '00000000-0000-4000-8000-0000000e2e01',
  'E2E-101',
  'דייר בדיקה',
  null,
  0, 0, 0, 0,
  false
)
on conflict (id) do nothing;

commit;
