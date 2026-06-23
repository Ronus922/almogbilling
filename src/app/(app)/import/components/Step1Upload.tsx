'use client';

import { useRef, useState } from 'react';
import { Upload, FileSpreadsheet } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { MAX_EXCEL_BYTES, worksheetToMatrix } from '@/lib/excel/workbook';
import { importErrorFromThrown } from '@/lib/excel/import-errors';

export function Step1Upload({
  onParsed,
}: {
  onParsed: (file: File, validRows: number, skipped: number) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  async function handleFile(file: File) {
    setError(null);
    setWorking(true);
    try {
      if (file.size > MAX_EXCEL_BYTES) {
        throw new Error(`קובץ גדול מדי (מקסימום ${Math.floor(MAX_EXCEL_BYTES / 1024 / 1024)}MB)`);
      }
      const buf = await file.arrayBuffer();
      const ExcelJS = (await import('exceljs')).default;
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf);
      const sheet = wb.worksheets[0];
      if (!sheet) throw new Error('הקובץ ריק');
      const matrix = worksheetToMatrix(sheet);
      let valid = 0;
      let skipped = 0;
      for (const r of matrix) {
        const apt = r[0] != null && String(r[0]).trim() !== '';
        if (apt) valid++; else skipped++;
      }
      onParsed(file, valid, skipped);
    } catch (e) {
      setError(importErrorFromThrown(e));
    } finally {
      setWorking(false);
    }
  }

  return (
    <Card className="p-10">
      <div className="flex items-center gap-2 text-primary">
        <FileSpreadsheet className="h-5 w-5" />
        <h2 className="text-lg font-bold">ייבוא דוח חייבים מאקסל</h2>
      </div>

      <div className="mt-8 flex flex-col items-center gap-3 text-center">
        <div className="grid h-16 w-16 place-items-center rounded-full bg-muted text-muted-foreground">
          <Upload className="h-8 w-8" />
        </div>
        <h3 className="text-lg font-semibold">העלאת קובץ אקסל</h3>
        <p className="text-sm text-muted-foreground">בחר קובץ XLSX עם דוח החייבים</p>

        <input
          ref={inputRef}
          type="file"
          accept=".xlsx"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
            e.target.value = '';
          }}
        />
        <Button
          type="button"
          className="mt-2 gap-2"
          disabled={working}
          onClick={() => inputRef.current?.click()}
        >
          <Upload className="h-4 w-4" />
          {working ? 'מעבד…' : 'בחר קובץ Excel'}
        </Button>
        <p className="text-xs text-muted-foreground">קבצים נתמכים: .xlsx</p>

        {error && (
          <Alert variant="destructive" className="mt-2 text-right">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>
    </Card>
  );
}
