'use client';

import { useRef, useState } from 'react';
import { Upload, FileSpreadsheet } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';

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
      const buf = await file.arrayBuffer();
      const XLSX = await import('xlsx');
      const wb = XLSX.read(buf, { type: 'array' });
      const sheetName = wb.SheetNames[0];
      if (!sheetName) throw new Error('הקובץ ריק');
      const sheet = wb.Sheets[sheetName];
      const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
        header: 1,
        range: 1,
        defval: null,
        blankrows: false,
      });
      let valid = 0;
      let skipped = 0;
      for (const r of matrix) {
        const apt = r[0] != null && String(r[0]).trim() !== '';
        if (apt) valid++; else skipped++;
      }
      onParsed(file, valid, skipped);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'שגיאה בקריאת הקובץ');
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
        <p className="text-sm text-muted-foreground">בחר קובץ XLS או XLSX עם דוח החייבים</p>

        <input
          ref={inputRef}
          type="file"
          accept=".xls,.xlsx"
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
        <p className="text-xs text-muted-foreground">קבצים נתמכים: .xls, .xlsx</p>

        {error && (
          <Alert variant="destructive" className="mt-2 text-right">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>
    </Card>
  );
}
