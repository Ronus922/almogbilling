'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  X, User as UserIcon, Shield, Activity, KeyRound, Power, PowerOff, LogIn, Lock,
} from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Section } from '@/components/side-panel/Section';
import { PanelFooter } from '@/components/side-panel/PanelFooter';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { RoleSelector } from './RoleSelector';
import { PermissionMatrix } from './PermissionMatrix';
import {
  ROLE_STYLES, roleLabel, isMatrixRole, ROLE_VALUES, type ModulePermission, type Role,
} from '@/lib/permissions/constants';
import { canManageRole } from '@/lib/permissions/check';
import { validatePhone } from '@/lib/validation';
import { isValidPassword } from '@/lib/auth/passwordPolicy';
import { PasswordField, PasswordRequirements } from '@/components/auth/PasswordField';
import { cn } from '@/lib/utils';
import type { UserListRow } from '@/lib/db/users';

interface Props {
  open: boolean;
  userId: string | null;
  currentUserId: string;
  currentUserRole: Role;
  onOpenChange: (open: boolean) => void;
}

interface UserResponse {
  user: UserListRow;
  permissions: ModulePermission[];
}

export function UserSidePanel({ open, userId, currentUserId, currentUserRole, onOpenChange }: Props) {
  const router = useRouter();
  const [user, setUser] = useState<UserListRow | null>(null);
  const [permissions, setPermissions] = useState<ModulePermission[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Draft fields (persisted via "שמור שינויים" button).
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('viewer');

  const [saving, setSaving] = useState(false);
  // Sticky flag — flips on after any auto-saved mutation (toggleActive,
  // matrix permission change). Keeps "שמור שינויים" enabled so the user
  // can click it as a "Done" button to close.
  const [hasMutated, setHasMutated] = useState(false);
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);
  const [confirmDisableOpen, setConfirmDisableOpen] = useState(false);

  // Fetch user + permissions on [open, userId]
  useEffect(() => {
    if (!open || !userId) {
      setUser(null);
      setPermissions([]);
      setError(null);
      setHasMutated(false);
      return;
    }
    let cancelled = false;
    setLoading(true); setError(null); setHasMutated(false);
    fetch(`/api/users/${userId}`, { credentials: 'include' })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((data: UserResponse) => {
        if (cancelled) return;
        setUser(data.user);
        setPermissions(data.permissions);
        setFullName(data.user.full_name ?? '');
        setPhone(data.user.notification_phone ?? '');
        setPassword('');
        setRole(data.user.role);
      })
      .catch((err: Error) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, userId]);

  const isSelf = user?.id === currentUserId;
  // Does the acting user have authority over this target's role at all?
  // admin → only manager/viewer; super_admin → everyone (incl. other super_admins).
  const canManageTarget = user ? canManageRole(currentUserRole, user.role) : false;
  const lacksAuthority = !!user && !canManageTarget;
  // Lifecycle actions (role change, enable/disable) are blocked only when acting
  // on self or on a target outside the actor's scope. The server additionally
  // refuses any change that would leave 0 active super_admins (last-admin guard).
  const actionsDisabled = isSelf || lacksAuthority;
  // Roles the actor may assign. admin managing manager/viewer → those two only;
  // otherwise the full list (selector is disabled anyway, but the current role
  // still highlights).
  const editableRoles: readonly Role[] = canManageTarget
    ? ROLE_VALUES.filter((r) => canManageRole(currentUserRole, r))
    : ROLE_VALUES;

  // Live phone validation — empty is allowed (the phone is optional); a non-empty
  // bad format shows an inline error and blocks save (same policy as suppliers).
  const phoneError = useMemo<string | null>(() => {
    const t = phone.trim();
    if (!t) return null;
    const v = validatePhone(t);
    return v.valid ? null : (v.error ?? 'מספר טלפון לא תקין');
  }, [phone]);

  // New password is optional; non-empty must meet the policy. Empty = unchanged.
  const passwordInvalid = password.length > 0 && !isValidPassword(password);

  const draftDirty = useMemo(() => {
    if (!user) return false;
    return (fullName.trim() !== (user.full_name ?? ''))
      || (phone.trim() !== (user.notification_phone ?? ''))
      || (password.length > 0)
      || (role !== user.role);
  }, [user, fullName, phone, password, role]);

  const isDirty = hasMutated || draftDirty;

  // Defensive ESC: panel listens only when no nested AlertDialog is open.
  useEscapeKey(open && !confirmCloseOpen && !confirmDisableOpen, () => requestClose());
  useEscapeKey(confirmCloseOpen, () => setConfirmCloseOpen(false));
  useEscapeKey(confirmDisableOpen, () => setConfirmDisableOpen(false));

  function requestClose() {
    if (isDirty) setConfirmCloseOpen(true);
    else onOpenChange(false);
  }

  function confirmDiscardClose() {
    setConfirmCloseOpen(false);
    onOpenChange(false);
  }

  async function handleSaveChanges() {
    if (!user || saving) return;

    if (!draftDirty) {
      // hasMutated && !draftDirty — auto-saves already persisted. Just close.
      onOpenChange(false);
      return;
    }

    const trimName = fullName.trim();
    const nameChanged = trimName !== (user.full_name ?? '');
    if (nameChanged && (trimName.length < 2 || trimName.length > 80)) {
      toast.error('שם מלא חייב להיות 2-80 תווים');
      return;
    }
    if (phoneError) {
      toast.error(phoneError);
      return;
    }
    if (passwordInvalid) {
      toast.error('הסיסמה לא עומדת בדרישות');
      return;
    }

    setSaving(true);
    try {
      const body: Record<string, unknown> = {};
      if (nameChanged) body.full_name = trimName;
      if (phone.trim() !== (user.notification_phone ?? '')) {
        const t = phone.trim();
        body.notification_phone = t ? validatePhone(t).normalized : null;
      }
      if (password.length > 0) body.password = password;
      if (role !== user.role) body.role = role;

      const r = await fetch(`/api/users/${user.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(data.error ?? 'שמירה נכשלה');
      toast.success('הפרופיל עודכן');
      router.refresh();
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive() {
    if (!user) return;
    const previous = user;
    const next = !user.is_active;
    setUser({ ...user, is_active: next }); // optimistic

    try {
      const r = await fetch(`/api/users/${user.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ is_active: next }),
      });
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(data.error ?? 'שינוי סטטוס נכשל');
      setHasMutated(true);
      toast.success(next ? 'המשתמש הופעל' : 'המשתמש הושבת');
      router.refresh();
    } catch (e) {
      setUser(previous); // rollback
      toast.error((e as Error).message);
    } finally {
      setConfirmDisableOpen(false);
    }
  }

  async function toggleGoogleAuth() {
    if (!user) return;
    const previous = user;
    const next = !user.allow_google_auth;
    setUser({ ...user, allow_google_auth: next }); // optimistic

    try {
      const r = await fetch(`/api/users/${user.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ allow_google_auth: next }),
      });
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(data.error ?? 'עדכון נכשל');
      setHasMutated(true);
      toast.success(next ? 'כניסה עם Google הופעלה' : 'כניסה עם Google כובתה');
      router.refresh();
    } catch (e) {
      setUser(previous); // rollback
      toast.error((e as Error).message);
    }
  }

  function handleMatrixMutated() {
    setHasMutated(true);
    router.refresh();
  }

  const matrixVisible = isMatrixRole(role);
  const styles = user ? ROLE_STYLES[user.role] : null;
  const roleLabelText = user ? roleLabel(user.role) : '';

  return (
    <>
      <Sheet open={open} onOpenChange={(o) => { if (!o) requestClose(); else onOpenChange(o); }}>
        <SheetContent
          side="left"
          dir="rtl"
          showCloseButton={false}
          className="w-full max-w-full p-0 sm:w-[92vw] md:w-[80vw] lg:w-[55vw] lg:min-w-[720px] flex flex-col gap-0 overflow-hidden bg-white"
        >
          {/* Header */}
          <SheetHeader className="flex-none gap-2 bg-gradient-to-bl from-slate-900 via-blue-950 to-blue-900 px-6 py-6 text-white">
            {loading ? (
              <div className="space-y-2">
                <div className="h-8 w-56 rounded bg-white/10 animate-pulse" />
                <div className="h-4 w-72 rounded bg-white/10 animate-pulse" />
              </div>
            ) : user && styles ? (
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <SheetTitle className="text-2xl font-bold text-white">
                      {user.full_name || user.email}
                    </SheetTitle>
                    <span className={cn(
                      'inline-flex items-center rounded-full px-3 py-0.5 text-xs font-semibold ring-1',
                      styles.bg, styles.fg, styles.ring,
                    )}>
                      {roleLabelText}
                    </span>
                    {!user.is_active && (
                      <span className="inline-flex items-center rounded-full bg-slate-100 px-3 py-0.5 text-xs font-semibold text-slate-600 ring-1 ring-slate-200">
                        מושבת
                      </span>
                    )}
                    {isSelf && (
                      <span className="inline-flex items-center rounded-full bg-white/15 px-3 py-0.5 text-xs font-semibold text-white">
                        אני
                      </span>
                    )}
                  </div>
                  <p dir="ltr" className="mt-1 text-sm text-white/70">{user.email}</p>
                </div>
                <button
                  type="button"
                  onClick={requestClose}
                  aria-label="סגור"
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/25 bg-white/5 text-white transition-colors hover:bg-white/15 hover:border-white/50"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            ) : null}
          </SheetHeader>

          {/* Body */}
          <div className="flex-1 overflow-y-auto bg-slate-50/60 p-5">
            {error ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
                שגיאה בטעינת הפרטים: {error}
              </div>
            ) : loading || !user ? (
              <div className="space-y-4">
                <div className="h-40 rounded-xl bg-muted/60 animate-pulse" />
                <div className="h-40 rounded-xl bg-muted/60 animate-pulse" />
              </div>
            ) : (
              <Tabs defaultValue="profile" className="w-full">
                <TabsList className="grid w-full grid-cols-3">
                  <TabsTrigger value="profile" className="gap-2">
                    <UserIcon className="h-4 w-4" /> פרופיל
                  </TabsTrigger>
                  <TabsTrigger value="permissions" className="gap-2">
                    <Shield className="h-4 w-4" /> תפקיד והרשאות
                  </TabsTrigger>
                  <TabsTrigger value="activity" className="gap-2" disabled>
                    <Activity className="h-4 w-4" /> פעילות
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="profile" className="mt-5 space-y-4">
                  <Section title="פרטי המשתמש" icon={UserIcon} iconTone="slate">
                    <div className="space-y-4 py-2">
                      <div className="space-y-2">
                        <Label htmlFor="user-fullname" className="text-base font-medium text-muted-foreground">שם מלא</Label>
                        <Input
                          id="user-fullname"
                          value={fullName}
                          onChange={(e) => setFullName(e.target.value)}
                          className="h-10"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label className="text-base font-medium text-muted-foreground">אימייל</Label>
                        <Input value={user.email} disabled dir="ltr" className="h-10" />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="user-phone" className="text-base font-medium text-muted-foreground">טלפון</Label>
                        <Input
                          id="user-phone"
                          value={phone}
                          onChange={(e) => setPhone(e.target.value)}
                          dir="ltr"
                          inputMode="tel"
                          placeholder="0501234567"
                          className={cn(
                            'h-10 tabular-nums',
                            phoneError && 'border-red-400 bg-red-50 focus-visible:ring-red-200',
                          )}
                        />
                        {phoneError ? (
                          <p className="text-[12px] font-semibold text-red-500 text-start">⚠️ {phoneError}</p>
                        ) : (
                          <p className="text-xs text-slate-500">משמש לקבלת התראות וואטסאפ. השאר ריק אם אין.</p>
                        )}
                      </div>
                      <div className="space-y-2">
                        <Label className="text-base font-medium text-muted-foreground">שם משתמש</Label>
                        <Input value={user.username} disabled dir="ltr" className="h-10" />
                      </div>
                    </div>
                  </Section>

                  {!actionsDisabled && (
                    <Section title="סיסמה" icon={Lock} iconTone="blue">
                      <div className="space-y-3 py-2">
                        <PasswordField
                          id="user-new-password"
                          label="סיסמה חדשה"
                          value={password}
                          onChange={setPassword}
                          disabled={saving}
                          error={passwordInvalid ? 'הסיסמה לא עומדת בדרישות' : null}
                        />
                        {password.length > 0 ? (
                          <PasswordRequirements value={password} />
                        ) : (
                          <p className="text-xs text-slate-500">
                            השאר ריק כדי לא לשנות. קביעת סיסמה חדשה תנתק את הסשנים הקיימים של המשתמש.
                          </p>
                        )}
                      </div>
                    </Section>
                  )}

                  <Section
                    title="סטטוס פעילות"
                    icon={user.is_active ? Power : PowerOff}
                    iconTone={user.is_active ? 'emerald' : 'slate'}
                  >
                    <div className="flex items-center justify-between py-2">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-slate-800">
                          {user.is_active ? 'משתמש פעיל' : 'משתמש מושבת'}
                        </div>
                        <div className="mt-0.5 text-xs text-slate-500">
                          {user.is_active
                            ? 'יוכל להתחבר וללחוץ על פעולות לפי הרשאותיו.'
                            : 'לא יוכל להתחבר. הסשנים נמחקו.'}
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          if (user.is_active) setConfirmDisableOpen(true);
                          else void toggleActive();
                        }}
                        disabled={actionsDisabled}
                        className={cn(
                          'gap-2 shrink-0',
                          user.is_active
                            ? 'border-red-200 text-red-600 hover:bg-red-50'
                            : 'border-emerald-200 text-emerald-700 hover:bg-emerald-50',
                        )}
                      >
                        {user.is_active ? <PowerOff className="h-4 w-4" /> : <Power className="h-4 w-4" />}
                        {user.is_active ? 'השבת' : 'הפעל'}
                      </Button>
                    </div>
                  </Section>

                  <Section title="כניסה עם Google" icon={LogIn} iconTone="blue">
                    <div className="flex items-center justify-between gap-4 py-2">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-slate-800">
                          {user.allow_google_auth ? 'מאופשרת' : 'כבויה'}
                        </div>
                        <div className="mt-0.5 text-xs text-slate-500">
                          {user.allow_google_auth
                            ? 'המשתמש יכול להתחבר עם חשבון Google התואם לאימייל שלו.'
                            : 'התחברות עם Google חסומה. כניסה עם שם משתמש וסיסמה תמיד זמינה.'}
                        </div>
                      </div>
                      <Switch
                        checked={user.allow_google_auth}
                        onCheckedChange={() => void toggleGoogleAuth()}
                        disabled={lacksAuthority}
                        aria-label="אפשר כניסה עם Google"
                        className="shrink-0"
                      />
                    </div>
                  </Section>
                </TabsContent>

                <TabsContent value="permissions" className="mt-5 space-y-4">
                  <Section title="תפקיד" icon={Shield} iconTone="violet">
                    <div className="py-2">
                      <RoleSelector
                        value={role}
                        onChange={setRole}
                        disabled={actionsDisabled}
                        allowedRoles={editableRoles}
                      />
                      {actionsDisabled && (
                        <p className="mt-3 text-xs text-slate-500">
                          {isSelf
                            ? 'אסור לשנות תפקיד של עצמך.'
                            : 'אין לך הרשאה לנהל משתמש בתפקיד זה.'}
                        </p>
                      )}
                    </div>
                  </Section>

                  {matrixVisible && role === user.role && (
                    <Section
                      title="מטריצת הרשאות"
                      icon={KeyRound}
                      iconTone="blue"
                      subtitle="חל רק על מנהל וצופה. שינוי שמור מיד."
                    >
                      <div className="py-2">
                        <PermissionMatrix
                          userId={user.id}
                          permissions={permissions}
                          onMutated={handleMatrixMutated}
                        />
                      </div>
                    </Section>
                  )}

                  {matrixVisible && role !== user.role && (
                    <div className="rounded-md border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
                      שמור את התפקיד החדש כדי לערוך את מטריצת ההרשאות.
                    </div>
                  )}

                  {!matrixVisible && (
                    <div className="rounded-md border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
                      סופר אדמין ואדמין לא משתמשים במטריצה — ההרשאות הן לפי הגדרות התפקיד.
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="activity" className="mt-5">
                  <div className="rounded-xl bg-white p-12 ring-1 ring-slate-200/70 text-center text-sm text-muted-foreground">
                    היסטוריית פעילות תיווסף בסליס נפרד.
                  </div>
                </TabsContent>
              </Tabs>
            )}
          </div>

          {/* Footer */}
          {!loading && user && (
            <PanelFooter
              onClose={requestClose}
              onSave={handleSaveChanges}
              saveDisabled={!isDirty || saving || !!phoneError || passwordInvalid}
              saveLabel={saving ? 'שומר…' : 'שמור שינויים'}
              showHistory
            />
          )}
        </SheetContent>
      </Sheet>

      {/* Confirm exit with unsaved changes */}
      <AlertDialog open={confirmCloseOpen} onOpenChange={setConfirmCloseOpen}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>האם לצאת ללא שמירה?</AlertDialogTitle>
            <AlertDialogDescription>
              ביצעת שינויים שלא נשמרו. אם תצא עכשיו, השינויים יאבדו.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>ביטול</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDiscardClose}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              צא ללא שמירה
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Confirm disable user */}
      <AlertDialog open={confirmDisableOpen} onOpenChange={setConfirmDisableOpen}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>להשבית את המשתמש?</AlertDialogTitle>
            <AlertDialogDescription>
              המשתמש לא יוכל להתחבר. הסשנים שלו יימחקו מיד. ניתן להפעיל מחדש בכל עת.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>חזור</AlertDialogCancel>
            <AlertDialogAction
              onClick={toggleActive}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              השבת
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
