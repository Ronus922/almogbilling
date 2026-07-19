#!/usr/bin/env node
// INVARIANT: the authorization matrix logic holds. Imports the REAL
//   hasPermission / canManageRole (no re-implementation) and locks the rules
//   that gate every requirePermission()/requireCanManageRole() guard:
//     • super_admin passes everything.
//     • admin is denied the super-admin-only modules and cannot manage an
//       elevated (admin/super_admin) role.
//     • a matrix role (manager/viewer/worker) is allowed ONLY what its
//       user_permissions rows grant — no row ⇒ denied.
//   Run under tsx (imports .ts source). Pure — no DB.
import { run, fail, ok } from './_check-lib.mjs';
import { hasPermission, canManageRole } from '../src/lib/permissions/check.ts';

run('check-rbac', async () => {
  const t = (name, cond) => (cond ? ok(name) : fail(name));

  // super_admin — unconditional
  t('super_admin רשאי users_management/edit', hasPermission('super_admin', [], 'users_management', 'edit') === true);
  t('super_admin רשאי כל מודול', hasPermission('super_admin', [], 'anything', 'edit') === true);

  // admin — everything EXCEPT super-admin-only modules
  t('admin נחסם users_management/view', hasPermission('admin', [], 'users_management', 'view') === false);
  t('admin נחסם roles_management/edit', hasPermission('admin', [], 'roles_management', 'edit') === false);
  t('admin רשאי dashboard/edit', hasPermission('admin', [], 'dashboard', 'edit') === true);

  // matrix role — ONLY what the rows grant
  t('manager ללא שורות נחסם', hasPermission('manager', [], 'dashboard', 'view') === false);
  const rows = [{ module: 'dashboard', canView: true, canEdit: false }];
  t('manager עם canView רשאי view', hasPermission('manager', rows, 'dashboard', 'view') === true);
  t('manager עם canView בלבד נחסם edit', hasPermission('manager', rows, 'dashboard', 'edit') === false);
  t('viewer עם canView רשאי view', hasPermission('viewer', rows, 'dashboard', 'view') === true);

  // canManageRole — admin can't touch elevated roles
  t('admin מנהל manager', canManageRole('admin', 'manager') === true);
  t('admin לא מנהל admin', canManageRole('admin', 'admin') === false);
  t('admin לא מנהל super_admin', canManageRole('admin', 'super_admin') === false);
  t('manager לא מנהל אף תפקיד', canManageRole('manager', 'viewer') === false);
  t('super_admin מנהל super_admin', canManageRole('super_admin', 'super_admin') === true);
});
