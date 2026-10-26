'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Scale } from 'lucide-react';
import {
  AlertDialog, AlertDialogCancel, AlertDialogAction, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { LegalStatusOption, LegalStatusSelect } from '@/components/common/LegalStatusSelect';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import type { Debtor } from '@/lib/db/debtors';
import type { LegalStatus } from '@/types/tenant';

const apartmentOrder = new Intl.Collator('he', { numeric: true });

/** "לדירה אחת" / "ל-3 דירות" — the destination of "עודכן סטטוס משפטי …". */
function toApartments(n: number): string {
  return n === 1 ? 'לדירה אחת' : `ל-${n} דירות`;
}

function failureMessage(httpStatus: number, code: string | undefined): string {
  if (httpStatus === 401 || httpStatus === 403) return 'אין הרשאה לעדכון סטטוס מרוכז';
  if (code === 'debtor_not_found') return 'אחת הדירות שנבחרו לא נמצאה — לא עודכנה אף דירה. רענן את הדף ונסה שוב';
  if (code === 'invalid_status_id') return 'הסטטוס שנבחר כבר אינו פעיל — לא עודכנה אף דירה';
  return 'העדכון נכשל — לא עודכנה אף דירה';
}

interface BulkResponse {
  updated: number;
  skipped: number;
  email: { sent: number; failed: number } | null;
}

/**
 * Admin-only bulk legal-status action of the debtors selection bar: the status
 * picker (GET /api/statuses — active, in the admin's order), "עדכן סטטוס", and
 * the confirmation that names the new status and every selected apartment. Only
 * the explicit confirm calls PUT /api/debtors/legal-status/bulk; the server
 * applies it to all the apartments or to none.
 */
export function BulkLegalStatusControls({
  rows,
  onDone,
}: {
  /** The selected rows, as the table shows them. */
  rows: Debtor[];
  /** Called after a successful update — the table clears its selection and refreshes. */
  onDone: () => void;
}) {
  const [statuses, setStatuses] = useState<LegalStatus[] | null>(null);
  const [statusesFailed, setStatusesFailed] = useState(false);
  const [statusId, setStatusId] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/statuses', { credentials: 'include' })
      .then((res) => (res.ok ? (res.json() as Promise<LegalStatus[]>) : Promise.reject(new Error(String(res.status)))))
      .then((list) => { if (!cancelled) setStatuses(list); })
      .catch(() => { if (!cancelled) setStatusesFailed(true); });
    return () => { cancelled = true; };
  }, []);

  useEscapeKey(confirmOpen && !submitting, () => setConfirmOpen(false));

  const target = statuses?.find((s) => s.id === statusId) ?? null;
  const apartments = rows.map((d) => d.apartment_number).sort((a, b) => apartmentOrder.compare(a, b));
  const alreadyThere = target ? rows.filter((d) => d.legal_status_id === target.id).length : 0;

  async function confirm() {
    if (!target || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/debtors/legal-status/bulk', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ debtor_ids: rows.map((d) => d.id), status_id: target.id }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(failureMessage(res.status, j.error));
        return;
      }
      const data = (await res.json()) as BulkResponse;
      if (data.updated === 0) {
        toast.info('כל הדירות שנבחרו כבר בסטטוס הזה — לא בוצע שינוי');
      } else {
        const skipped = data.skipped > 0 ? ` · ${data.skipped} כבר היו בסטטוס הזה` : '';
        toast.success(`עודכן סטטוס משפטי ${toApartments(data.updated)}${skipped}`);
      }
      if (data.email && data.email.failed > 0) {
        toast.warning('הסטטוס עודכן, אך שליחת מייל ההתראה נכשלה');
      }
      setConfirmOpen(false);
      onDone();
    } catch {
      toast.error('העדכון נכשל — לא עודכנה אף דירה');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="w-full sm:w-64">
        <LegalStatusSelect
          statuses={statuses ?? []}
          value={statusId}
          onValueChange={setStatusId}
          disabled={statuses === null || statuses.length === 0}
          placeholder={statusesFailed ? 'טעינת הסטטוסים נכשלה' : statuses === null ? 'טוען סטטוסים…' : 'בחר סטטוס משפטי…'}
          className="data-[size=default]:h-11 bg-white"
          side="top"
        />
      </div>
      <Button type="button" onClick={() => setConfirmOpen(true)} disabled={!target} className="w-full gap-2 sm:w-auto">
        <Scale className="h-4 w-4" />
        עדכן סטטוס
      </Button>

      <AlertDialog open={confirmOpen} onOpenChange={(o) => { if (!submitting) setConfirmOpen(o); }}>
        <AlertDialogContent dir="rtl" className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>לעדכן סטטוס משפטי {toApartments(rows.length)}?</AlertDialogTitle>
            <AlertDialogDescription render={<div />} className="space-y-3 text-start">
              <div className="flex flex-wrap items-center gap-2">
                <span>הסטטוס החדש:</span>
                {target && (
                  <span className="font-semibold text-ink">
                    <LegalStatusOption status={target} />
                  </span>
                )}
              </div>
              <div className="space-y-1.5">
                <div>הדירות שנבחרו:</div>
                <ul className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto rounded-lg border border-line bg-surface-2 p-3">
                  {apartments.map((a) => (
                    <li key={a} className="font-num rounded-md border border-line bg-white px-2 py-0.5 text-xs font-bold tabular-nums text-ink">
                      {a}
                    </li>
                  ))}
                </ul>
              </div>
              {alreadyThere > 0 && (
                <div>
                  {alreadyThere === 1 ? 'דירה אחת מהן כבר בסטטוס הזה' : `${alreadyThere} מהן כבר בסטטוס הזה`} ולא תשתנה.
                </div>
              )}
              <div>אם הוגדרו לסטטוס נמעני התראה, יישלח אליהם מייל מרוכז אחד.</div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>ביטול</AlertDialogCancel>
            <AlertDialogAction onClick={confirm} disabled={submitting} className="gap-2">
              <Scale className="h-4 w-4" />
              {submitting ? 'מעדכן…' : 'עדכן סטטוס'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
