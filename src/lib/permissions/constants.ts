export type Role = 'super_admin' | 'admin' | 'manager' | 'viewer' | 'cleaner' | 'maintenance';
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

// `level` is presentational (ordering/hierarchy hint) — no code branches on it.
// The field-worker roles share the lowest tier with viewer: they are narrow, not
// senior. They differ from viewer in shape, not rank — a viewer reads the
// debtors screen, a worker edits their own tasks/issues and nothing else.
export const ROLES: RoleMeta[] = [
  { value: 'super_admin', label: 'סופר אדמין',  description: 'גישה מלאה לכל המערכת',                     level: 4 },
  { value: 'admin',       label: 'אדמין',       description: 'גישה לכל המודולים פרט לניהול משתמשים',     level: 3 },
  { value: 'manager',     label: 'מנהל',        description: 'הרשאות לפי מטריצה — ערוך מודולים תפעוליים', level: 2 },
  { value: 'viewer',      label: 'צופה',        description: 'הרשאות לפי מטריצה — צפייה בלבד',           level: 1 },
  { value: 'cleaner',     label: 'עובד ניקיון', description: 'עובד שטח — משימות ותקלות בלבד',            level: 1 },
  { value: 'maintenance', label: 'עובד אחזקה',  description: 'עובד שטח — משימות ותקלות בלבד',            level: 1 },
];

/** Every role value, in ROLES order. Derive from here — never re-list the union. */
export const ROLE_VALUES: readonly Role[] = ROLES.map((r) => r.value);

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
  cleaner:     { bg: 'bg-sky-50',     fg: 'text-sky-700',     ring: 'ring-sky-200'     },
  maintenance: { bg: 'bg-amber-50',   fg: 'text-amber-700',   ring: 'ring-amber-200'   },
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

// Field-worker defaults (cleaner + maintenance) — tasks + issues only, view+edit.
// `edit` is what lets a worker actually work: POST /api/tasks and every status
// PATCH are guarded on it. (POST /api/issues needs only `view` — reporting a
// fault is deliberately open — but starting/completing one is an edit.)
// Everything else is off: no debtors, no contacts, no suppliers, no settings.
//
// ponytail: one array, two roles. The roles differ in *what gets assigned to
// them*, not in what they may do. Split into DEFAULT_CLEANER / DEFAULT_MAINTENANCE
// the day their permissions actually diverge — not before.
export const DEFAULT_WORKER: ModulePermission[] = [
  noPerm('analytics'),
  noPerm('dashboard'),
  noPerm('contacts'),
  noPerm('suppliers'),
  noPerm('whatsapp'),
  perm('tasks',  true, true),
  perm('issues', true, true),
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

// ── Role classification ──────────────────────────────────────────────────────
// Single source of truth for "where do this role's permissions come from".
//
// ROLE_DEFAULTS holds the seed matrix of every role whose permissions live as
// per-user rows in public.user_permissions. A role is matrix-managed IFF it has
// an entry here — isMatrixRole() reads these keys rather than repeating the role
// list, so the seed table and the "does this role have a matrix" test cannot
// drift apart. Adding a matrix-managed role = one entry here.
//
// super_admin / admin are absent by design: they bypass the matrix entirely
// (see hasPermission) and never own user_permissions rows.
export const ROLE_DEFAULTS: Partial<Record<Role, ModulePermission[]>> = {
  manager: DEFAULT_MANAGER,
  viewer: DEFAULT_VIEWER,
  cleaner: DEFAULT_WORKER,
  maintenance: DEFAULT_WORKER,
};

/** True for a field-worker role — drives the worker-first mobile view on /issues. */
export function isWorkerRole(role: Role): boolean {
  return role === 'cleaner' || role === 'maintenance';
}

/** True when this role's permissions are read from the user_permissions matrix. */
export function isMatrixRole(role: Role): boolean {
  return ROLE_DEFAULTS[role] !== undefined;
}

/**
 * Roles that bypass the permission matrix. Kept separate from isMatrixRole()
 * on purpose: "has a permission matrix" and "may an admin manage this user" are
 * two different questions, and fusing them would turn a future role addition
 * into a silent privilege escalation.
 */
export function isElevatedRole(role: Role): boolean {
  return role === 'super_admin' || role === 'admin';
}
