'use client';

import { CheckCircle2, AlertTriangle, ArrowRight, ArrowLeft } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const COLUMNS_RIGHT = [
  { col: 'A', label: 'דירה' },
  { col: 'C', label: 'טלפון' },
  { col: 'E', label: 'דמי ניהול' },
  { col: 'G', label: 'מים חמים' },
];
const COLUMNS_LEFT = [
  { col: 'B', label: 'שם' },
  { col: 'D', label: 'סה״כ' },
  { col: 'F', label: 'דמי ניהול לחודשים' },
  { col: 'H', label: 'פרטים' },
];

export type ImportMode = 'merge' | 'replace';

export function Step2MappingMode({
  fileName,
  validRows,
  mode,
  onModeChange,
  onBack,
  onNext,
}: {
  fileName: string;
  validRows: number;
  mode: ImportMode;
  onModeChange: (m: ImportMode) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <Card className="p-8">
      <h2 className="text-lg font-bold">ייבוא דוח חייבים מאקסל</h2>

      <div className="mt-6 flex items-center gap-3 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
        <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0" />
        <div>
          קובץ האקסל <span className="font-semibold">{fileName}</span> נטען בהצלחה.
          נמצאו <span className="font-semibold">{validRows}</span> דירות ייחודיות לייבוא.
        </div>
      </div>

      <div className="mt-6 rounded-md border border-blue-200 bg-blue-50 p-4">
        <h3 className="font-semibold text-blue-900">מיפוי קבוע:</h3>
        <div className="mt-3 grid grid-cols-2 gap-3 text-sm text-blue-900">
          <ul className="space-y-1">
            {COLUMNS_RIGHT.map((c) => (
              <li key={c.col} className="flex items-center justify-between">
                <span>{c.label}</span>
                <span className="font-mono text-xs">{c.col} →</span>
              </li>
            ))}
          </ul>
          <ul className="space-y-1">
            {COLUMNS_LEFT.map((c) => (
              <li key={c.col} className="flex items-center justify-between">
                <span>{c.label}</span>
                <span className="font-mono text-xs">{c.col} →</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="mt-6">
        <h3 className="text-sm font-medium text-muted-foreground">מצב ייבוא</h3>
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          <ModeOption
            selected={mode === 'merge'}
            tone="blue"
            title="השלמה בלבד (מומלץ)"
            onClick={() => onModeChange('merge')}
            bullets={[
              'טלפונים: עדכון רק אם ריקים',
              'סכומים: עדכון תמיד מעמודות D/E/G',
              'דירות שלא בקובץ: מתאפסות',
            ]}
          />
          <ModeOption
            selected={mode === 'replace'}
            tone="red"
            title="איפוס מלא"
            onClick={() => onModeChange('replace')}
            bullets={['מחיקה מלאה של כל הנתונים']}
            warning
          />
        </div>
      </div>

      <div className="mt-6 flex items-center justify-between">
        <Button type="button" variant="outline" onClick={onBack} className="gap-2">
          <ArrowRight className="h-4 w-4" />
          חזור
        </Button>
        <Button type="button" onClick={onNext} className="gap-2">
          צפה בתצוגה מקדימה
          <ArrowLeft className="h-4 w-4" />
        </Button>
      </div>
    </Card>
  );
}

function ModeOption({
  selected,
  tone,
  title,
  bullets,
  warning,
  onClick,
}: {
  selected: boolean;
  tone: 'blue' | 'red';
  title: string;
  bullets: string[];
  warning?: boolean;
  onClick: () => void;
}) {
  const toneClasses =
    tone === 'red'
      ? selected
        ? 'border-red-500 bg-red-50'
        : 'border-red-200 bg-red-50/50 hover:bg-red-50'
      : selected
        ? 'border-blue-500 bg-blue-50'
        : 'border-blue-200 bg-blue-50/50 hover:bg-blue-50';
  const dotTone = tone === 'red' ? 'border-red-500 text-red-600' : 'border-blue-500 text-blue-600';
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-md border-2 p-4 text-right transition-colors',
        toneClasses,
      )}
    >
      <div className="flex items-center justify-between">
        <h4 className={cn('font-semibold', tone === 'red' ? 'text-red-900' : 'text-blue-900')}>
          {title}
        </h4>
        <span
          className={cn(
            'grid h-5 w-5 place-items-center rounded-full border-2',
            dotTone,
          )}
        >
          {selected && <span className={cn('h-2.5 w-2.5 rounded-full', tone === 'red' ? 'bg-red-600' : 'bg-blue-600')} />}
        </span>
      </div>
      <ul className={cn('mt-3 space-y-1 text-xs', tone === 'red' ? 'text-red-800' : 'text-blue-800')}>
        {warning && (
          <li className="flex items-center gap-1.5 font-medium">
            <AlertTriangle className="h-3.5 w-3.5" />
            <span>פעולה הרסנית — דורשת אישור כפול</span>
          </li>
        )}
        {bullets.map((b) => (
          <li key={b} className="flex items-center gap-2">
            <span className="text-muted-foreground">•</span>
            <span>{b}</span>
          </li>
        ))}
      </ul>
    </button>
  );
}
