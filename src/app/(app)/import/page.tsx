'use client';

import { useState } from 'react';
import { FileSpreadsheet, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { usePermissions } from '@/lib/auth/context';
import { ContactImportPanel } from '@/components/contacts/contact-import-panel';
import { Step1Upload } from './components/Step1Upload';
import { Step2MappingMode, type ImportMode } from './components/Step2MappingMode';
import { Step3PreviewProgress } from './components/Step3PreviewProgress';

interface ParsedFile {
  file: File;
  validRows: number;
  skippedRows: number;
}

type ImportTab = 'debtors' | 'residents';

const RESIDENTS_FORMAT =
  'קובץ Excel: עמודה A מספר דירה · B שם · C טלפון · D תפקיד (בעל / שוכר / מפעיל; ריק = בעל). מיזוג בלבד — תא ריק לא מוחק נתונים, ודירה חסרה נוצרת במרשם.';

export default function ImportPage() {
  const { can } = usePermissions();
  const canEditContacts = can('contacts', 'edit');

  const [tab, setTab] = useState<ImportTab>('debtors');
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [parsed, setParsed] = useState<ParsedFile | null>(null);
  const [mode, setMode] = useState<ImportMode>('merge');
  const [residentsOpen, setResidentsOpen] = useState(false);

  const tabs: Array<{ key: ImportTab; label: string; icon: typeof FileSpreadsheet }> = [
    { key: 'debtors', label: 'דוח חייבים', icon: FileSpreadsheet },
    { key: 'residents', label: 'ייבוא דיירים', icon: Users },
  ];

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold">ייבוא נתונים</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {tab === 'debtors'
            ? `העלה קובץ Excel עם דוח החייבים. השלב ${step} מתוך 3.`
            : 'ייבוא מרשם דיירים — שורה לכל אדם.'}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {tabs.map((t) => {
          const isActive = t.key === tab;
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={cn(
                'h-[60px] w-full inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-xl px-2.5 py-0 text-xs sm:text-sm font-semibold leading-none transition-colors cursor-pointer',
                isActive
                  ? 'bg-blue-600 text-white shadow-soft-sm'
                  : 'bg-white text-ink-2 border border-line hover:bg-row-hover',
              )}
              aria-current={isActive ? 'page' : undefined}
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden />
              <span>{t.label}</span>
            </button>
          );
        })}
      </div>

      {tab === 'debtors' && (
        <>
          {step === 1 && (
            <Step1Upload
              onParsed={(file, validRows, skippedRows) => {
                setParsed({ file, validRows, skippedRows });
                setStep(2);
              }}
            />
          )}

          {step === 2 && parsed && (
            <Step2MappingMode
              fileName={parsed.file.name}
              validRows={parsed.validRows}
              mode={mode}
              onModeChange={setMode}
              onBack={() => setStep(1)}
              onNext={() => setStep(3)}
            />
          )}

          {step === 3 && parsed && (
            <Step3PreviewProgress
              file={parsed.file}
              mode={mode}
              validRows={parsed.validRows}
              skippedRows={parsed.skippedRows}
              onBack={() => setStep(2)}
            />
          )}
        </>
      )}

      {tab === 'residents' && (
        <div
          className={cn(
            'rounded-lg border bg-card p-6 space-y-4',
            !canEditContacts && 'opacity-60',
          )}
        >
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-blue-100 text-blue-600">
              <Users className="h-5 w-5" />
            </span>
            <div className="min-w-0 space-y-1">
              <h2 className="text-base font-bold">ייבוא דיירים</h2>
              <p className="text-sm text-muted-foreground">{RESIDENTS_FORMAT}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button
              type="button"
              className="gap-2"
              disabled={!canEditContacts}
              onClick={() => setResidentsOpen(true)}
            >
              <Users className="h-4 w-4" /> ייבוא דיירים
            </Button>
            {!canEditContacts && (
              <span className="text-xs text-muted-foreground">אין הרשאה</span>
            )}
          </div>
        </div>
      )}

      <ContactImportPanel
        open={residentsOpen}
        onOpenChange={setResidentsOpen}
        onImported={() => undefined}
        endpoint="/api/residents/import"
        title="ייבוא דיירים"
        description={RESIDENTS_FORMAT}
      />
    </div>
  );
}
