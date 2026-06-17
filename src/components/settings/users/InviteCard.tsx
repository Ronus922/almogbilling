'use client';

import { useState } from 'react';
import { RotateCw, X, Clock } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { roleLabel } from '@/lib/permissions/constants';
import { cn } from '@/lib/utils';
import type { InviteListRow } from '@/lib/db/users';

interface Props {
  invite: InviteListRow;
  onResend: (id: string) => Promise<void>;
  onCancel: (id: string) => Promise<void>;
}

function initialsFromName(fullName: string, fallback: string): string {
  const src = fullName.trim() || fallback;
  if (!src) return '–';
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0]!.charAt(0) + parts[1]!.charAt(0)).toUpperCase();
  }
  return src.slice(0, 2).toUpperCase();
}

function daysUntil(iso: string): number {
  const ms = new Date(iso).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

export function InviteCard({ invite, onResend, onCancel }: Props) {
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  useEscapeKey(confirmCancel && !busy, () => setConfirmCancel(false));

  const initials = initialsFromName(invite.full_name, invite.email);
  const expiresInDays = daysUntil(invite.expires_at);

  async function handleResend(e: React.MouseEvent) {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try { await onResend(invite.id); } finally { setBusy(false); }
  }

  async function handleCancel() {
    if (busy) return;
    setBusy(true);
    try { await onCancel(invite.id); } finally { setBusy(false); setConfirmCancel(false); }
  }

  return (
    <>
      <div
        className="w-full rounded-lg border border-slate-200 bg-white p-4
                   flex items-center gap-3"
      >
        {/* Avatar (amber to distinguish from active users) */}
        <span
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full
                     bg-amber-100 text-amber-700 text-xs font-bold"
          aria-hidden
        >
          {initials}
        </span>

        {/* Details */}
        <div className="min-w-0 flex-1">
          <div className="text-base font-semibold text-slate-900 truncate">
            {invite.full_name}
          </div>
          <div
            dir="ltr"
            className="text-sm text-muted-foreground tabular-nums truncate text-start"
          >
            {invite.email}
          </div>
        </div>

        {/* Pending pill with tooltip */}
        <Tooltip>
          <TooltipTrigger render={<span className="block shrink-0" />}>
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-amber-200">
              <Clock className="h-3 w-3" aria-hidden />
              ממתין להצטרפות
            </span>
          </TooltipTrigger>
          <TooltipContent>
            הקישור יפוג בעוד {expiresInDays} {expiresInDays === 1 ? 'יום' : 'ימים'}
          </TooltipContent>
        </Tooltip>

        {/* Role badge */}
        <span
          className={cn(
            'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium shrink-0 bg-slate-100 text-slate-700',
          )}
        >
          {roleLabel(invite.role)}
        </span>

        {/* Inline action icons */}
        <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={handleResend}
                  disabled={busy}
                  className="p-1.5 rounded text-blue-600 hover:text-blue-700 hover:bg-blue-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  aria-label="שלח שוב"
                />
              }
            >
              <RotateCw className={cn('h-4 w-4', busy && 'animate-spin')} />
            </TooltipTrigger>
            <TooltipContent>שלח שוב</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => setConfirmCancel(true)}
                  disabled={busy}
                  className="p-1.5 rounded text-rose-500 hover:text-rose-600 hover:bg-rose-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  aria-label="בטל הזמנה"
                />
              }
            >
              <X className="h-4 w-4" />
            </TooltipTrigger>
            <TooltipContent>בטל הזמנה</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <AlertDialog open={confirmCancel} onOpenChange={(v) => { if (!v) setConfirmCancel(false); }}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>לבטל את ההזמנה?</AlertDialogTitle>
            <AlertDialogDescription>
              ההזמנה תוסר מהמערכת. ניתן לשלוח הזמנה חדשה לכתובת המייל.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>חזור</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleCancel}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              בטל הזמנה
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
