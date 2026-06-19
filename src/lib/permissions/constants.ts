export type Role = 'super_admin' | 'admin' | 'manager' | 'viewer';
export type Action = 'view' | 'edit';

export interface ModulePermission {
  module: string;
  canView: boolean;
  canEdit: boolean;
}

export interface RoleMeta {
  value: Role;
  label: string;
  description: string;
  level: number;
}

export const ROLES: RoleMeta[] = [
  { value: 'super_admin', label: 'סופר אדמין', description: 'גישה מלאה לכל המערכת',                     level: 4 },
  { value: 'admin',       label: 'אדמין',      description: 'גישה לכל המודולים פרט לניהול משתמשים',     level: 3 },
  { value: 'manager',     label: 'מנהל',       description: 'הרשאות לפי מטריצה — ערוך מודולים תפעוליים', level: 2 },
  { value: 'viewer',      label: 'צופה',       description: 'הרשאות לפי מטריצה — צפייה בלבד',           level: 1 },
];

/**
 * Single source of truth for a role's Hebrew display label. Use everywhere a
 * role name is shown (tabs, cards, panels, emails) so labels never drift.
 */
export function roleLabel(role: Role): string {
  return ROLES.find((r) => r.value === role)?.label ?? role;
}

export const ROLE_STYLES: Record<Role, { bg: string; fg: string; ring: string }> = {
  super_admin: { bg: 'bg-violet-50',  fg: 'text-violet-700',  ring: 'ring-violet-200'  },
  admin:       { bg: 'bg-blue-50',    fg: 'text-blue-700',    ring: 'ring-blue-200'    },
  manager:     { bg: 'bg-emerald-50', fg: 'text-emerald-700', ring: 'ring-emerald-200' },
  viewer:      { bg: 'bg-slate-100',  fg: 'text-slate-600',   ring: 'ring-slate-200'   },
};

export interface ModuleMeta {
  key: string;
  label: string;
  group: 'main' | 'admin';
}

export const MODULES: ModuleMeta[] = [
  // Main (12)
  { key: 'analytics',          label: 'אנליטיקה',           group: 'main' },
  { key: 'dashboard',          label: 'ניהול חיובים',       group: 'main' },
  { key: 'contacts',           label: 'רשימת דיירים',       group: 'main' },
  { key: 'suppliers',          label: 'ספקים',              group: 'main' },
  { key: 'whatsapp',           label: 'שליחת ווטסאפ',       group: 'main' },
  { key: 'tasks',              label: 'משימות',             group: 'main' },
  { key: 'issues',             label: 'תקלות',              group: 'main' },
  { key: 'calendar',           label: 'יומן',               group: 'main' },
  { key: 'documents',          label: 'מסמכים',             group: 'main' },
  { key: 'whatsapp_chat',      label: 'צ׳אט ווטסאפ',        group: 'main' },
  { key: 'internal_chat',      label: 'צ׳אט פנימי',         group: 'main' },
  { key: 'user_reminders',     label: 'תזכורות',            group: 'main' },
  // Admin (8)
  { key: 'import',             label: 'ייבוא נתונים',       group: 'admin' },
  { key: 'export',             label: 'ייצוא נתונים',       group: 'admin' },
  { key: 'status_management',  label: 'ניהול סטטוס חיובים', group: 'admin' },
  { key: 'whatsapp_templates', label: 'תבניות ווטסאפ',      group: 'admin' },
  { key: 'rooms_areas',        label: 'ניהול אזורים',       group: 'admin' },
  { key: 'roles_management',   label: 'הרשאות',             group: 'admin' },
  { key: 'users_management',   label: 'ניהול משתמשים',      group: 'admin' },
  { key: 'settings',           label: 'הגדרות',             group: 'admin' },
];

export const SUPER_ADMIN_ONLY: readonly string[] = ['users_management', 'roles_management'];

function noPerm(module: string): ModulePermission {
  return { module, canView: false, canEdit: false };
}
function perm(module: string, view: boolean, edit: boolean): ModulePermission {
  return { module, canView: view, canEdit: edit };
}

// Manager defaults — full operational access: view+edit on EVERY module except
// settings / users_management / roles_management (admin-only — the line that
// separates manager from admin). "edit" covers all mutations within the module
// (delete, export, send-message, sync, status change, etc).
export const DEFAULT_MANAGER: ModulePermission[] = [
  perm('analytics',     true,  true),
  perm('dashboard',     true,  true),
  perm('contacts',      true,  true),
  perm('suppliers',     true,  true),
  perm('whatsapp',      true,  true),
  perm('tasks',         true,  true),
  perm('issues',        true,  true),
  perm('calendar',      true,  true),
  perm('documents',     true,  true),
  perm('whatsapp_chat', true,  true),
  perm('internal_chat', true,  true),
  perm('user_reminders', true,  true),
  perm('import',            true,  true),
  perm('export',            true,  true),
  perm('status_management', true,  true),
  perm('whatsapp_templates', true, true),
  perm('rooms_areas',       true,  true),
  noPerm('roles_management'),
  noPerm('users_management'),
  noPerm('settings'),
];

// Viewer defaults — read-only access to the DEBTORS SCREEN (dashboard) ONLY.
// Every other module is fully off (no view, no edit). The debtors screen lives
// at /dashboard ("ניהול חיובים"): the table, KPIs, status tabs (warning / legal /
// actions / archived) and the per-debtor detail panel (detail, comments,
// history, completed-actions, status display). Those panel reads are granted to
// a viewer via the `dashboard` permission in their route guards — see
// requireAnyPermission() in /api/debtors/* and /api/statuses — so a viewer can
// read the whole debtors screen WITHOUT holding `contacts` or `status_management`
// (which would otherwise expose the standalone tenants list / status-admin
// screens). Export/print is intentionally withheld (no `export`) → read-only.
export const DEFAULT_VIEWER: ModulePermission[] = [
  noPerm('analytics'),
  perm('dashboard', true, false),
  noPerm('contacts'),
  noPerm('suppliers'),
  noPerm('whatsapp'),
  noPerm('tasks'),
  noPerm('issues'),
  noPerm('calendar'),
  noPerm('documents'),
  noPerm('whatsapp_chat'),
  noPerm('internal_chat'),
  noPerm('user_reminders'),
  noPerm('import'),
  noPerm('export'),
  noPerm('status_management'),
  noPerm('whatsapp_templates'),
  noPerm('rooms_areas'),
  noPerm('roles_management'),
  noPerm('users_management'),
  noPerm('settings'),
];
