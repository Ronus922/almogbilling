'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import { MODULES, type ModulePermission } from '@/lib/permissions/constants';

interface Props {
  /**
   * Auto-save mode: matrix calls PUT /api/users/{userId}/permissions on each
   * toggle and emits onMutated() on success. Used by UserSidePanel.
   *
   * Controlled mode: pass `value` + `onChange`. Matrix never calls the API
   * and never shows a toast — parent owns state and submits on its own
   * timing. Used by InviteUserPanel.
   */
  userId?: string;
  /** Initial state for auto-save mode. Ignored in controlled mode. */
  permissions: ModulePermission[];
  /** Controlled mode source-of-truth. Provide together with `onChange`. */
  value?: ModulePermission[];
  onChange?: (next: ModulePermission[]) => void;
  /** Auto-save success callback. Ignored in controlled mode. */
  onMutated?: () => void;
  disabled?: boolean;
}

type Field = 'can_view' | 'can_edit';

function findPerm(perms: ModulePermission[], module: string): ModulePermission {
  return perms.find((p) => p.module === module) ?? {
    module, canView: false, canEdit: false,
  };
}

export function PermissionMatrix({
  userId, permissions, value, onChange, onMutated, disabled,
}: Props) {
  const isControlled = value !== undefined && onChange !== undefined;

  // Internal state used only in auto-save mode.
  const [optimistic, setOptimistic] = useState<ModulePermission[]>(permissions);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const current = isControlled ? value : optimistic;

  function buildNext(module: string, field: Field, val: boolean): ModulePermission[] {
    const before = findPerm(current, module);
    const after: ModulePermission = {
      module,
      canView: field === 'can_view' ? val : before.canView,
      canEdit: field === 'can_edit' ? val : before.canEdit,
    };
    const others = current.filter((p) => p.module !== module);
    return [...others, after];
  }

  async function toggle(module: string, field: Field, val: boolean) {
    const next = buildNext(module, field, val);

    if (isControlled) {
      // Parent owns state — no API, no toast, no busy spinner.
      onChange!(next);
      return;
    }

    // Auto-save mode (UserSidePanel).
    const key = `${module}:${field}`;
    setBusyKey(key);
    const before = optimistic;
    setOptimistic(next);
    try {
      const r = await fetch(`/api/users/${userId}/permissions`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          module,
          can_view: findPerm(next, module).canView,
          can_edit: findPerm(next, module).canEdit,
        }),
      });
      if (!r.ok) {
        const data = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? 'שמירה נכשלה');
      }
      toast.success('הרשאה עודכנה');
      onMutated?.();
    } catch (err) {
      // rollback
      setOptimistic(before);
      toast.error((err as Error).message);
    } finally {
      setBusyKey(null);
    }
  }

  const groups: Array<{ key: 'main' | 'admin'; title: string }> = [
    { key: 'main', title: 'תפריט ראשי' },
    { key: 'admin', title: 'ניהול' },
  ];

  return (
    <div className="space-y-5">
      {groups.map((g) => (
        <div key={g.key}>
          <h4 className="mb-2 text-sm font-bold text-slate-800">{g.title}</h4>
          <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
            <Table>
              <TableHeader className="[&_tr]:border-b [&_tr]:border-slate-200">
                <TableRow className="bg-slate-50 hover:bg-slate-50">
                  <TableHead className="h-10 px-4 text-start text-sm font-semibold text-slate-500">מודול</TableHead>
                  <TableHead className="h-10 px-4 text-center text-sm font-semibold text-slate-500">צפייה</TableHead>
                  <TableHead className="h-10 px-4 text-center text-sm font-semibold text-slate-500">עריכה</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {MODULES.filter((m) => m.group === g.key).map((m) => {
                  const p = findPerm(current, m.key);
                  const viewBusy = busyKey === `${m.key}:can_view`;
                  const editBusy = busyKey === `${m.key}:can_edit`;
                  return (
                    <TableRow key={m.key} className="border-b border-slate-100 h-11">
                      <TableCell className="px-4 py-2 text-sm font-medium text-slate-800">{m.label}</TableCell>
                      <TableCell className="px-4 py-2 text-center">
                        <div className="inline-flex">
                          <Checkbox
                            checked={p.canView}
                            disabled={disabled || viewBusy}
                            onCheckedChange={(v) => toggle(m.key, 'can_view', v === true)}
                            aria-label={`${m.label} — צפייה`}
                          />
                        </div>
                      </TableCell>
                      <TableCell className="px-4 py-2 text-center">
                        <div className="inline-flex">
                          <Checkbox
                            checked={p.canEdit}
                            disabled={disabled || editBusy}
                            onCheckedChange={(v) => toggle(m.key, 'can_edit', v === true)}
                            aria-label={`${m.label} — עריכה`}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </div>
      ))}
    </div>
  );
}
