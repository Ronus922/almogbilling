'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { X, User as UserIcon, Shield, KeyRound, Lock } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Section } from '@/components/side-panel/Section';
import { PanelFooter } from '@/components/side-panel/PanelFooter';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { RoleSelector } from './RoleSelector';
import { PermissionMatrix } from './PermissionMatrix';
import { PasswordField, PasswordRequirements } from '@/components/auth/PasswordField';
import { getDefaultPermissions } from '@/lib/permissions/check';
import { isValidPassword } from '@/lib/auth/passwordPolicy';
import { roleLabel, type ModulePermission, type Role } from '@/lib/permissions/constants';

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_ROLE: Role = 'manager';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Role of the acting user — scopes which roles can be invited. */
  currentUserRole: Role;
}

function defaultsFor(role: Role): ModulePermission[] {
  return getDefaultPermissions(role) ?? [];
}

// True only when the current matrix diverges from the role's defaults. When it
// matches (or the role has no matrix), the invite stores custom_permissions =
// NULL and accept-invite falls back to role defaults — preserving legacy behavior.
function permsDifferFromDefaults(current: ModulePermission[], role: Role): boolean {
  const defaults = defaultsFor(role);
  if (defaults.length === 0) return false;
  const byModule = new Map(current.map((p) => [p.module, p]));
  return defaults.some((d) => {
    const c = byModule.get(d.module);
    return !c || c.canView !== d.canView || c.canEdit !== d.canEdit;
  });
}

export function InviteUserPanel({ open, onOpenChange, currentUserRole }: Props) {
  const router = useRouter();
  // super_admin may invite any role (incl. super_admin); admin may invite
  // manager/viewer only. Enforced again server-side in POST /api/users.
  const creatableRoles: Role[] = currentUserRole === 'super_admin'
    ? ['super_admin', 'admin', 'manager', 'viewer']
    : ['manager', 'viewer'];
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>(DEFAULT_ROLE);
  const [permissions, setPermissions] = useState<ModulePermission[]>(() => defaultsFor(DEFAULT_ROLE));
  const [submitting, setSubmitting] = useState(false);
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);

  // Fresh form on every open.
  useEffect(() => {
    if (open) {
      setFullName('');
      setEmail('');
      setPassword('');
      setRole(DEFAULT_ROLE);
      setPermissions(defaultsFor(DEFAULT_ROLE));
    }
  }, [open]);

  // Reset matrix when role changes — defaults for matrix-managed roles, [] otherwise.
  useEffect(() => {
    setPermissions(defaultsFor(role));
  }, [role]);

  // Dirty = user typed in any text field. Role/permission tinkering doesn't
  // count — the role selector has a default, and matrix has defaults; closing
  // without filling name/email loses no real work.
  const dirty = fullName.trim().length > 0 || email.trim().length > 0 || password.length > 0;

  const trimmedName = fullName.trim();
  const trimmedEmail = email.trim();
  // Password is OPTIONAL: empty → invite email; non-empty → must meet the policy.
  const passwordInvalid = password.length > 0 && !isValidPassword(password);
  const canSubmit =
    trimmedName.length >= 2 &&
    trimmedName.length <= 80 &&
    EMAIL_RX.test(trimmedEmail) &&
    !passwordInvalid &&
    !submitting;

  // Defensive ESC: panel listens unless the cancel-confirm dialog is open.
  useEscapeKey(open && !confirmCloseOpen, () => requestClose());
  useEscapeKey(confirmCloseOpen, () => setConfirmCloseOpen(false));

  function requestClose() {
    if (submitting) return;
    if (dirty) setConfirmCloseOpen(true);
    else onOpenChange(false);
  }

  function confirmDiscardClose() {
    setConfirmCloseOpen(false);
    onOpenChange(false);
  }

  async function handleSubmit() {
    if (!canSubmit) return;

    setSubmitting(true);
    try {
      const withPassword = password.length > 0;
      const body: Record<string, unknown> = {
        full_name: trimmedName,
        email: trimmedEmail.toLowerCase(),
        role,
      };
      // Password present → direct create (no invite email). Empty → invite.
      if (withPassword) body.password = password;
      // Only send the matrix when the admin actually tweaked it. Unchanged →
      // omit → server stores custom_permissions = NULL → role defaults at accept.
      if ((role === 'manager' || role === 'viewer') && permsDifferFromDefaults(permissions, role)) {
        body.permissions = permissions.map((p) => ({
          module: p.module,
          can_view: p.canView,
          can_edit: p.canEdit,
        }));
      }

      const r = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(data.error ?? 'יצירת המשתמש נכשלה');
      toast.success(withPassword ? 'המשתמש נוצר' : 'המשתמש נוצר והוזמן');
      router.refresh();
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
      // Stay open. Fields preserved. User can fix and retry.
    } finally {
      setSubmitting(false);
    }
  }

  const matrixVisible = role === 'manager' || role === 'viewer';

  return (
    <>
      <Sheet open={open} onOpenChange={(o) => { if (!o) requestClose(); else onOpenChange(o); }}>
        <SheetContent
          side="left"
          dir="rtl"
          showCloseButton={false}
          className="w-full p-0 sm:w-[55vw] md:min-w-[720px] flex flex-col gap-0 overflow-hidden bg-white"
        >
          {/* Header */}
          <SheetHeader className="flex-none gap-2 bg-gradient-to-bl from-slate-900 via-blue-950 to-blue-900 px-6 py-6 text-white">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <SheetTitle className="text-2xl font-bold text-white">צור משתמש</SheetTitle>
                <p className="mt-1 text-sm text-white/70">
                  מלא סיסמה כדי ליצור עובד מיד, או השאר ריק כדי לשלוח מייל הזמנה (תקף 24 שעות).
                </p>
              </div>
              <button
                type="button"
                onClick={requestClose}
                aria-label="סגור"
                disabled={submitting}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/25 bg-white/5 text-white transition-colors hover:bg-white/15 hover:border-white/50 disabled:opacity-60"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </SheetHeader>

          {/* Body */}
          <div className="flex-1 overflow-y-auto bg-slate-50/60 p-5">
            <div className="space-y-4">
              <Section title="פרטי המשתמש" icon={UserIcon} iconTone="slate">
                <div className="space-y-4 py-2">
                  <div className="space-y-2">
                    <Label htmlFor="invite-name" className="text-base font-medium text-muted-foreground">
                      שם מלא
                    </Label>
                    <Input
                      id="invite-name"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      disabled={submitting}
                      className="h-10"
                      autoFocus
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="invite-email" className="text-base font-medium text-muted-foreground">
                      אימייל
                    </Label>
                    <Input
                      id="invite-email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      disabled={submitting}
                      dir="ltr"
                      className="h-10"
                      placeholder="user@example.com"
                    />
                  </div>
                </div>
              </Section>

              <Section title="סיסמה (אופציונלי)" icon={Lock} iconTone="blue">
                <div className="space-y-3 py-2">
                  <PasswordField
                    id="invite-password"
                    label="סיסמה"
                    value={password}
                    onChange={setPassword}
                    disabled={submitting}
                    error={passwordInvalid ? 'הסיסמה לא עומדת בדרישות' : null}
                  />
                  {password.length > 0 ? (
                    <PasswordRequirements value={password} />
                  ) : (
                    <p className="text-xs text-slate-500">
                      מלא סיסמה כדי ליצור עובד מיד (שם משתמש = האימייל, ללא מייל הזמנה). השאר ריק כדי לשלוח הזמנה.
                    </p>
                  )}
                </div>
              </Section>

              <Section title="תפקיד" icon={Shield} iconTone="violet">
                <div className="py-2">
                  <RoleSelector
                    value={role}
                    onChange={setRole}
                    disabled={submitting}
                    allowedRoles={creatableRoles}
                  />
                </div>
              </Section>

              {matrixVisible ? (
                <Section
                  title="הרשאות"
                  icon={KeyRound}
                  iconTone="blue"
                  subtitle="ברירת המחדל לפי התפקיד שנבחר. אפשר לכוונן לפני שליחה."
                >
                  <div className="py-2">
                    <PermissionMatrix
                      permissions={permissions}
                      value={permissions}
                      onChange={setPermissions}
                      disabled={submitting}
                    />
                  </div>
                </Section>
              ) : (
                <div className="rounded-md border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
                  תפקיד &quot;{roleLabel(role)}&quot; אינו משתמש במטריצת הרשאות — ההרשאות נקבעות לפי התפקיד. אין צורך בכוונון.
                </div>
              )}
            </div>
          </div>

          {/* Footer */}
          <PanelFooter
            onClose={requestClose}
            onSave={handleSubmit}
            saveDisabled={!canSubmit}
            saveLabel={submitting ? 'יוצר…' : 'צור משתמש'}
          />
        </SheetContent>
      </Sheet>

      {/* Confirm cancel-create */}
      <AlertDialog open={confirmCloseOpen} onOpenChange={setConfirmCloseOpen}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>לבטל יצירת משתמש?</AlertDialogTitle>
            <AlertDialogDescription>
              השדות שמילאת יימחקו. ניתן להתחיל מחדש בכל עת.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>המשך עריכה</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDiscardClose}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              בטל
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
