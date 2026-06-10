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
  { value: 'super_admin', label: 'סופר אדמין',  description: 'גישה מלאה לכל המערכת',                     level: 4 },
  { value: 'admin',       label: 'מנהל',        description: 'גישה לכל המודולים פרט לניהול משתמשים',     level: 3 },
  { value: 'manager',     label: 'מנהל פעילות', description: 'הרשאות לפי מטריצה — ערוך מודולים תפעוליים', level: 2 },
  { value: 'viewer',      label: 'צופה',        description: 'הרשאות לפי מטריצה — צפייה בלבד',           level: 1 },
];

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
  // Main (11)
  { key: 'analytics',          label: 'אנליטיקה',           group: 'main' },
  { key: 'dashboard',          label: 'ניהול חיובים',       group: 'main' },
  { key: 'contacts',           label: 'רשימת דיירים',       group: 'main' },
  { key: 'suppliers',          label: 'ספקים',              group: 'main' },
  { key: 'tasks',              label: 'משימות',             group: 'main' },
  { key: 'issues',             label: 'תקלות',              group: 'main' },
  { key: 'calendar',           label: 'יומן',               group: 'main' },
  { key: 'documents',          label: 'מסמכים',             group: 'main' },
  { key: 'whatsapp_chat',      label: 'צ׳אט ווטסאפ',        group: 'main' },
  { key: 'internal_chat',      label: 'צ׳אט פנימי',         group: 'main' },
  { key: 'reminders',          label: 'תזכורות',            group: 'main' },
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

// Manager defaults — main modules editable, import/export/status_management view-only,
// other admin modules off. "edit" covers all mutations within the module (delete, export,
// send-message, etc).
export const DEFAULT_MANAGER: ModulePermission[] = [
  perm('analytics',     true,  true),
  perm('dashboard',     true,  true),
  perm('contacts',      true,  true),
  perm('suppliers',     true,  true),
  perm('tasks',         true,  true),
  perm('issues',        true,  true),
  perm('calendar',      true,  true),
  perm('documents',     true,  true),
  perm('whatsapp_chat', true,  true),
  perm('internal_chat', true,  true),
  perm('reminders',     true,  true),
  perm('import',            true,  false),
  perm('export',            true,  false),
  perm('status_management', true,  false),
  noPerm('whatsapp_templates'),
  noPerm('rooms_areas'),
  noPerm('roles_management'),
  noPerm('users_management'),
  noPerm('settings'),
];

// Viewer defaults — main view-only, export view-only, rest off.
export const DEFAULT_VIEWER: ModulePermission[] = [
  perm('analytics',     true, false),
  perm('dashboard',     true, false),
  perm('contacts',      true, false),
  perm('suppliers',     true, false),
  perm('tasks',         true, false),
  perm('issues',        true, false),
  perm('calendar',      true, false),
  perm('documents',     true, false),
  perm('whatsapp_chat', true, false),
  perm('internal_chat', true, false),
  perm('reminders',     true, false),
  noPerm('import'),
  perm('export',            true, false),
  noPerm('status_management'),
  noPerm('whatsapp_templates'),
  noPerm('rooms_areas'),
  noPerm('roles_management'),
  noPerm('users_management'),
  noPerm('settings'),
];
