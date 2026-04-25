'use client';

import { useState } from 'react';
import { Step1Upload } from './components/Step1Upload';
import { Step2MappingMode, type ImportMode } from './components/Step2MappingMode';
import { Step3PreviewProgress } from './components/Step3PreviewProgress';

interface ParsedFile {
  file: File;
  validRows: number;
  skippedRows: number;
}

export default function ImportPage() {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [parsed, setParsed] = useState<ParsedFile | null>(null);
  const [mode, setMode] = useState<ImportMode>('merge');

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold">ייבוא נתונים</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          העלה קובץ Excel עם דוח החייבים. השלב {step} מתוך 3.
        </p>
      </div>

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
    </div>
  );
}
