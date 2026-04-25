'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, CheckCircle2, Lock, AlertTriangle } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { toast } from 'sonner';
import { ReplaceConfirmDialog } from './ReplaceConfirmDialog';
import type { ImportMode } from './Step2MappingMode';

const UPDATED_FIELDS = [
  'apartment_number', 'owner_name', 'address', 'monthly_debt',
  'management_fees', 'total_debt', 'hot_water_debt', 'special_debt',
];
const PROTECTED_FIELDS = [
  'phone_owner', 'phone_tenant', 'email_owner', 'email_tenant',
  'phones_raw', 'operator_id', 'tenant_name', 'legal_status_id',
];

interface RunStatus {
  id: string;
  status: 'running' | 'success' | 'error';
  total_rows: number;
  processed_rows: number;
  updated_rows: number;
  created_rows: number;
  skipped_rows: number;
  error_message: string | null;
}

export function Step3PreviewProgress({
  file,
  mode,
  validRows,
  skippedRows,
  onBack,
}: {
  file: File;
  mode: ImportMode;
  validRows: number;
  skippedRows: number;
  onBack: () => void;
}) {
  const router = useRouter();
  const [running, setRunning] = useState<RunStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Quick preview math (estimates only — server is authoritative)
  const preview = {
    skipped: skippedRows,
    updated: mode === 'replace' ? 0 : validRows,
    created: mode === 'replace' ? validRows : 0,
  };

  async function startImport(adminPassword?: string) {
    setSubmitting(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('mode', mode);
      if (adminPassword) fd.append('adminPassword', adminPassword);

      const res = await fetch('/api/debtors/import', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) {
        const msg =
          data?.error === 'invalid_password' ? 'סיסמה שגויה' :
          data?.error === 'password_required' ? 'יש להזין סיסמה' :
          'שגיאה בייבוא';
        throw new Error(msg);
      }
      const runId: string = data.runId;
      setRunning({
        id: runId,
        status: 'running',
        total_rows: validRows,
        processed_rows: 0,
        updated_rows: 0,
        created_rows: 0,
        skipped_rows: skippedRows,
        error_message: null,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'שגיאה');
      throw e;
    } finally {
      setSubmitting(false);
    }
  }

  // Polling
  useEffect(() => {
    if (!running || running.status !== 'running') return;
    const id = setInterval(async () => {
      try {
        const res = await fetch(`/api/debtors/import/status/${running.id}`);
        if (!res.ok) return;
        const next: RunStatus = await res.json();
        setRunning(next);
        if (next.status === 'success') {
          toast.success(
            `הייבוא הושלם — ${next.updated_rows} עודכנו, ${next.created_rows} נוצרו, ${next.skipped_rows} דולגו`,
          );
          setTimeout(() => router.push('/dashboard'), 800);
        } else if (next.status === 'error') {
          setError(next.error_message ?? 'שגיאה לא ידועה');
        }
      } catch {/* ignore single poll failure */}
    }, 500);
    return () => clearInterval(id);
  }, [running, router]);

  if (running) {
    const pct = running.total_rows > 0
      ? Math.min(100, Math.round((running.processed_rows / running.total_rows) * 100))
      : 0;

    return (
      <Card className="p-8 space-y-4">
        <h2 className="text-lg font-bold">ייבוא דוח חייבים מאקסל</h2>

        {running.status === 'error' ? (
          <Alert variant="destructive">
            <AlertDescription>{running.error_message ?? error}</AlertDescription>
          </Alert>
        ) : (
          <div className="rounded-md border bg-blue-50 p-4">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium text-blue-900">
                מעדכן רשומות ({running.processed_rows}/{running.total_rows})…
              </span>
              <span className="text-blue-900 font-semibold">{pct}%</span>
            </div>
            <Progress value={pct} className="mt-3" />
            <p className="mt-2 text-xs text-center text-blue-800">ייבוא חכם עם Throttle ו-Retry</p>
          </div>
        )}
      </Card>
    );
  }

  return (
    <>
      <Card className="p-8 space-y-6">
        <h2 className="text-lg font-bold">ייבוא דוח חייבים מאקסל</h2>

        <div>
          <h3 className="text-base font-semibold">תצוגה מקדימה של הייבוא</h3>
          <p className="mt-1 text-sm text-muted-foreground">לפני ביצוע — בדוק מה יעודכן:</p>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <StatBox value={preview.skipped} label="דולגו שורות" tone="orange" />
          <StatBox value={preview.updated} label="עדכנו דירות קיימות" tone="blue" />
          <StatBox value={preview.created} label="יוצרו דירות חדשות" tone="green" />
        </div>

        <FieldsBox
          tone="green"
          icon={<CheckCircle2 className="h-4 w-4" />}
          title="שדות מורשים לעדכון:"
          fields={UPDATED_FIELDS}
        />
        <FieldsBox
          tone="red"
          icon={<Lock className="h-4 w-4" />}
          title="שדות מוגנים — לא יתעדכנו:"
          fields={PROTECTED_FIELDS}
        />

        {mode === 'merge' && (
          <div className="rounded-md border border-yellow-200 bg-yellow-50 p-4 text-sm text-yellow-900">
            <div className="flex items-center gap-2 font-semibold">
              <AlertTriangle className="h-4 w-4" />
              <span>כללי MERGE בלבד:</span>
            </div>
            <ul className="mt-2 space-y-1 text-yellow-800">
              <li>• אם שדה ריק באקסל וקיים במערכת — השדה הקיים נשמר</li>
              <li>• טלפונים, הערות, תגיות — לעולם לא מתעדכנים</li>
              <li>• מפעיל (operator_id) — לעולם לא משתנה</li>
              <li>• סטטוס משפטי — לא משתנה אם נעול</li>
            </ul>
          </div>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="flex items-center justify-between">
          <Button type="button" variant="outline" onClick={onBack} className="gap-2" disabled={submitting}>
            <ArrowRight className="h-4 w-4" />
            חזור
          </Button>
          <Button
            type="button"
            onClick={() => mode === 'replace' ? setConfirmOpen(true) : startImport()}
            disabled={submitting}
          >
            {submitting ? 'שולח…' : 'בצע ייבוא'}
          </Button>
        </div>
      </Card>

      <ReplaceConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onConfirm={(pwd) => startImport(pwd)}
      />
    </>
  );
}

function StatBox({ value, label, tone }: { value: number; label: string; tone: 'orange' | 'blue' | 'green' }) {
  const cls =
    tone === 'orange' ? 'border-orange-200 bg-orange-50 text-orange-900' :
    tone === 'blue' ? 'border-blue-200 bg-blue-50 text-blue-900' :
    'border-emerald-200 bg-emerald-50 text-emerald-900';
  return (
    <div className={`rounded-md border p-4 text-center ${cls}`}>
      <div className="text-2xl font-extrabold">{value}</div>
      <div className="mt-1 text-xs">{label}</div>
    </div>
  );
}

function FieldsBox({ tone, icon, title, fields }: {
  tone: 'green' | 'red'; icon: React.ReactNode; title: string; fields: string[];
}) {
  const cls = tone === 'green'
    ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
    : 'border-red-200 bg-red-50 text-red-900';
  return (
    <div className={`rounded-md border p-4 ${cls}`}>
      <div className="flex items-center gap-2 font-semibold">
        {icon}
        <span>{title}</span>
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        {fields.map((f) => (
          <li key={f} className="flex items-center gap-2">
            <span className="text-muted-foreground">•</span>
            <code className="text-xs">{f}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}
