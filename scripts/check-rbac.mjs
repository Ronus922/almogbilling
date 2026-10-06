#!/usr/bin/env node
// INVARIANT: the authorization matrix logic holds. Imports the REAL
//   hasPermission / canManageRole (no re-implementation) and locks the rules
//   that gate every requirePermission()/requireCanManageRole() guard:
//     • super_admin passes everything.
//     • admin is denied the super-admin-only modules and cannot manage an
//       elevated (admin/super_admin) role.
//     • a matrix role (manager/viewer/worker) is allowed ONLY what its
//       user_permissions rows grant — no row ⇒ denied.
//     • the personal assistant is STAFF-ONLY: a role off ASSISTANT_ROLES (a
//       field worker, a future resident) is denied even with matrix rows.
//     • a portal reporter's phone follows contacts:view (owners' contact
//       details) — never a field worker's by default.
//     • a supplier's additional contacts follow suppliers:edit — no module of
//       their own; a viewer (even with suppliers:view) never manages them.
//   Run under tsx (imports .ts source). Pure — no DB.
import { run, fail, ok } from './_check-lib.mjs';
import { hasPermission, canManageRole, canUseAssistant, canSeeReporterPhone, canDeleteUsers } from '../src/lib/permissions/check.ts';
import { DEFAULT_MANAGER, DEFAULT_VIEWER, DEFAULT_WORKER } from '../src/lib/permissions/constants.ts';

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

  // portal_manage (owners portal: the roster, the login log, manual unlocks) —
  // admin / super_admin only, deny-by-default for every matrix role. Same shape
  // as `finance`: no user_permissions row ⇒ denied, so no re-seed was needed.
  t('portal_manage: super_admin רשאי edit', hasPermission('super_admin', [], 'portal_manage', 'edit') === true);
  t('portal_manage: admin רשאי edit', hasPermission('admin', [], 'portal_manage', 'edit') === true);
  t('portal_manage: manager ללא שורה נחסם', hasPermission('manager', [], 'portal_manage', 'view') === false);

  // portal_decisions (/decisions: the PDFs the owners portal publishes) — the
  // same shape as portal_manage: admin / super_admin, deny-by-default for every
  // matrix role, including a viewer carrying its whole default matrix.
  t('portal_decisions: super_admin רשאי edit', hasPermission('super_admin', [], 'portal_decisions', 'edit') === true);
  t('portal_decisions: admin רשאי edit', hasPermission('admin', [], 'portal_decisions', 'edit') === true);
  t('portal_decisions: manager ללא שורה נחסם', hasPermission('manager', [], 'portal_decisions', 'view') === false);
  t('portal_decisions: manager עם המטריצה המלאה נחסם', hasPermission('manager', DEFAULT_MANAGER, 'portal_decisions', 'view') === false);
  t('portal_decisions: viewer (qa-viewer) נחסם', hasPermission('viewer', DEFAULT_VIEWER, 'portal_decisions', 'view') === false);
  t('portal_decisions: worker נחסם', hasPermission('cleaner', DEFAULT_WORKER, 'portal_decisions', 'view') === false);
  t('portal_manage: viewer ללא שורה נחסם', hasPermission('viewer', [], 'portal_manage', 'view') === false);
  t('portal_manage: cleaner ללא שורה נחסם', hasPermission('cleaner', [], 'portal_manage', 'view') === false);

  // canManageRole — admin can't touch elevated roles
  t('admin מנהל manager', canManageRole('admin', 'manager') === true);
  t('admin לא מנהל admin', canManageRole('admin', 'admin') === false);
  t('admin לא מנהל super_admin', canManageRole('admin', 'super_admin') === false);
  t('manager לא מנהל אף תפקיד', canManageRole('manager', 'viewer') === false);
  t('super_admin מנהל super_admin', canManageRole('super_admin', 'super_admin') === true);

  // canUseAssistant — staff-role ALLOWLIST + the debtors-screen gate (dashboard
  // OR contacts view). Allowlist, not blocklist: a role that is not listed is
  // denied even when its rows would pass the permission gate.
  const dash = [{ module: 'dashboard', canView: true, canEdit: false }];
  t('assistant: super_admin רשאי', canUseAssistant('super_admin', []) === true);
  t('assistant: admin רשאי', canUseAssistant('admin', []) === true);
  t('assistant: manager עם dashboard/view רשאי', canUseAssistant('manager', dash) === true);
  t('assistant: manager בלי שורות נחסם', canUseAssistant('manager', []) === false);
  t('assistant: viewer עם dashboard/view רשאי', canUseAssistant('viewer', dash) === true);
  t('assistant: cleaner נחסם גם עם dashboard/view', canUseAssistant('cleaner', dash) === false);
  t('assistant: maintenance נחסם גם עם dashboard/view', canUseAssistant('maintenance', dash) === false);
  t('assistant: תפקיד עתידי (resident) נחסם כברירת מחדל', canUseAssistant('resident', dash) === false);

  // canSeeReporterPhone — the phone of a resident who reported a fault from the
  // portal is an owner's contact detail: contacts:view, no new module. The
  // route sends it, and the panel shows it, only when this is true.
  t('reporter phone: super_admin רשאי', canSeeReporterPhone('super_admin', []) === true);
  t('reporter phone: admin רשאי', canSeeReporterPhone('admin', []) === true);
  t('reporter phone: manager (מטריצת ברירת מחדל) רשאי', canSeeReporterPhone('manager', DEFAULT_MANAGER) === true);
  t('reporter phone: manager בלי contacts/view נחסם', canSeeReporterPhone('manager', [{ module: 'issues', canView: true, canEdit: true }]) === false);
  t('reporter phone: cleaner (ברירת מחדל) נחסם', canSeeReporterPhone('cleaner', DEFAULT_WORKER) === false);
  t('reporter phone: maintenance (ברירת מחדל) נחסם', canSeeReporterPhone('maintenance', DEFAULT_WORKER) === false);
  t('reporter phone: viewer (ברירת מחדל) נחסם', canSeeReporterPhone('viewer', DEFAULT_VIEWER) === false);

  // Additional supplier contacts ("הוסף איש קשר נוסף", 04/10/2026) — NO new
  // module: whoever may create/edit a supplier manages its additional contacts,
  // through the same POST/PATCH (requirePermission('suppliers','edit')) and the
  // same canEdit gate in the UI. The default matrix must keep that true.
  const supView = [{ module: 'suppliers', canView: true, canEdit: false }];
  t('אנשי קשר נוספים: admin רשאי suppliers/edit', hasPermission('admin', [], 'suppliers', 'edit') === true);
  t('אנשי קשר נוספים: manager (ברירת מחדל) רשאי suppliers/edit', hasPermission('manager', DEFAULT_MANAGER, 'suppliers', 'edit') === true);
  t('אנשי קשר נוספים: viewer (ברירת מחדל) נחסם suppliers/edit', hasPermission('viewer', DEFAULT_VIEWER, 'suppliers', 'edit') === false);
  t('אנשי קשר נוספים: viewer עם suppliers/view בלבד נחסם edit', hasPermission('viewer', supView, 'suppliers', 'edit') === false);
  t('אנשי קשר נוספים: viewer עם suppliers/view רשאי לצפות', hasPermission('viewer', supView, 'suppliers', 'view') === true);
  t('אנשי קשר נוספים: cleaner (ברירת מחדל) נחסם suppliers/edit', hasPermission('cleaner', DEFAULT_WORKER, 'suppliers', 'edit') === false);

  // canDeleteUsers — the permanent deletion of a staff user (06/10/2026) is an
  // ALLOWLIST of the super admin alone. An admin may disable a manager/viewer
  // (canManageRole) but never delete anyone, and no matrix row grants it.
  const usersEdit = [{ module: 'users_management', canView: true, canEdit: true }];
  t('מחיקת משתמש: super_admin רשאי', canDeleteUsers('super_admin') === true);
  t('מחיקת משתמש: admin נחסם', canDeleteUsers('admin') === false);
  t('מחיקת משתמש: manager נחסם', canDeleteUsers('manager') === false);
  t('מחיקת משתמש: viewer נחסם', canDeleteUsers('viewer') === false);
  t('מחיקת משתמש: cleaner נחסם', canDeleteUsers('cleaner') === false);
  t('מחיקת משתמש: maintenance נחסם', canDeleteUsers('maintenance') === false);
  t('מחיקת משתמש: שורת users_management/edit במטריצה לא מעניקה', hasPermission('manager', usersEdit, 'users_management', 'edit') === true && canDeleteUsers('manager') === false);
});
