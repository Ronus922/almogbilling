'use client';

import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';

export function ReplaceConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onConfirm: (password: string) => Promise<void> | void;
}) {
  const [stage, setStage] = useState<1 | 2>(1);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setStage(1);
    setPassword('');
    setError(null);
    setSubmitting(false);
  }

  async function handleConfirm() {
    if (!password) {
      setError('שדה חובה');
      return;
    }
    setSubmitting(true);
    try {
      await onConfirm(password);
      reset();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'שגיאה');
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="grid h-12 w-12 place-items-center rounded-full bg-red-100 text-red-600">
            <AlertTriangle className="h-6 w-6" />
          </div>
          <DialogTitle>
            {stage === 1 ? 'אישור איפוס מלא' : 'פעולה בלתי הפיכה — אימות סיסמה'}
          </DialogTitle>
          <DialogDescription>
            {stage === 1
              ? 'פעולה זו תמחק את כל נתוני החייבים הקיימים ותיצור אותם מחדש מהקובץ. האם אתה בטוח?'
              : 'הזן את הסיסמה שלך כדי לאשר את האיפוס המלא. לאחר אישור — הנתונים נמחקים מיד.'}
          </DialogDescription>
        </DialogHeader>

        {stage === 2 && (
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="adminPassword">סיסמה</Label>
              <Input
                id="adminPassword"
                type="password"
                value={password}
                autoComplete="current-password"
                onChange={(e) => setPassword(e.target.value)}
                dir="ltr"
              />
            </div>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </div>
        )}

        <DialogFooter className="sm:justify-between gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              if (stage === 2) setStage(1);
              else { reset(); onOpenChange(false); }
            }}
          >
            {stage === 2 ? 'חזור' : 'ביטול'}
          </Button>
          {stage === 1 ? (
            <Button
              type="button"
              className="gap-2 bg-red-600 hover:bg-red-700 text-white"
              onClick={() => setStage(2)}
            >
              <AlertTriangle className="h-4 w-4" />
              כן, אני בטוח
            </Button>
          ) : (
            <Button
              type="button"
              className="gap-2 bg-red-600 hover:bg-red-700 text-white"
              onClick={handleConfirm}
              disabled={submitting}
            >
              <AlertTriangle className="h-4 w-4" />
              {submitting ? 'מבצע…' : 'בצע איפוס'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
