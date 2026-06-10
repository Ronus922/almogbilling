'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Mail, Send, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';

const GMAIL_RX = /^[^\s@]+@gmail\.com$/i;
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function SmtpSettingsCard() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [fromEmail, setFromEmail] = useState('');
  const [fromName, setFromName] = useState('ALMOG CRM');
  const [password, setPassword] = useState('');
  const [hasPassword, setHasPassword] = useState(false);

  const [testOpen, setTestOpen] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [testSending, setTestSending] = useState(false);

  useEscapeKey(testOpen && !testSending, () => setTestOpen(false));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/settings/smtp');
        if (!r.ok) throw new Error('failed');
        const d = (await r.json()) as { fromEmail: string; fromName: string; hasPassword: boolean };
        if (cancelled) return;
        setFromEmail(d.fromEmail ?? '');
        setFromName(d.fromName ?? 'ALMOG CRM');
        setHasPassword(Boolean(d.hasPassword));
      } catch {
        if (!cancelled) toast.error('טעינת הגדרות נכשלה');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (saving) return;

    const cleanedPass = password.replace(/\s+/g, '');
    const trimmedEmail = fromEmail.trim();
    const trimmedName = fromName.trim();

    if (!GMAIL_RX.test(trimmedEmail)) {
      toast.error('חייב להיות חשבון Gmail');
      return;
    }
    if (trimmedName.length < 1 || trimmedName.length > 50) {
      toast.error('שם השולח חייב להיות באורך 1-50 תווים');
      return;
    }
    if (cleanedPass && cleanedPass.length !== 16) {
      toast.error('App Password חייב להכיל 16 תווים');
      return;
    }
    if (!hasPassword && !cleanedPass) {
      toast.error('App Password נדרש');
      return;
    }

    setSaving(true);
    try {
      const r = await fetch('/api/settings/smtp', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fromEmail: trimmedEmail,
          fromName: trimmedName,
          password: cleanedPass || undefined,
        }),
      });
      const data = (await r.json()) as { error?: string };
      if (!r.ok) throw new Error(data.error ?? 'שמירה נכשלה');
      toast.success('הגדרות נשמרו');
      setPassword('');
      setHasPassword(true);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function onSendTest() {
    if (testSending) return;
    if (!EMAIL_RX.test(testTo.trim())) {
      toast.error('כתובת אימייל לא תקינה');
      return;
    }
    setTestSending(true);
    try {
      const r = await fetch('/api/settings/smtp/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: testTo.trim() }),
      });
      const data = (await r.json()) as { error?: string };
      if (!r.ok) throw new Error(data.error ?? 'שליחה נכשלה');
      toast.success('מייל בדיקה נשלח');
      setTestOpen(false);
      setTestTo('');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setTestSending(false);
    }
  }

  return (
    <Card className="ring-1 ring-slate-200/70 shadow-[0_1px_2px_rgba(15,23,42,0.04)] p-6">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-blue-50 text-blue-600">
          <Mail className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-slate-900">הגדרות שליחת מייל</h2>
          <p className="mt-1 text-sm text-slate-500">Gmail בלבד</p>
        </div>
      </div>

      <form onSubmit={onSave} className="mt-6 flex flex-col gap-5" noValidate>
        <div className="space-y-2">
          <Label htmlFor="fromEmail" className="text-base font-medium text-muted-foreground">
            כתובת Gmail
          </Label>
          <Input
            id="fromEmail"
            type="email"
            value={fromEmail}
            onChange={(e) => setFromEmail(e.target.value)}
            placeholder="your-account@gmail.com"
            dir="ltr"
            disabled={loading || saving}
            className="h-10"
            required
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="fromName" className="text-base font-medium text-muted-foreground">
            שם השולח
          </Label>
          <Input
            id="fromName"
            value={fromName}
            onChange={(e) => setFromName(e.target.value)}
            placeholder="ALMOG CRM"
            disabled={loading || saving}
            className="h-10"
            required
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="password" className="text-base font-medium text-muted-foreground">
            App Password
          </Label>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={hasPassword ? '••••••••••••••••' : '16 תווים מ-Google App Passwords'}
            dir="ltr"
            disabled={loading || saving}
            className="h-10"
            autoComplete="off"
          />
          <a
            href="https://myaccount.google.com/apppasswords"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:underline"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            צור App Password ב-Google
          </a>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-2">
          <Button
            type="submit"
            disabled={loading || saving}
            className="bg-blue-600 hover:bg-blue-700 text-white gap-2"
          >
            {saving ? 'שומר…' : 'שמור'}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => setTestOpen(true)}
            disabled={loading || saving || !hasPassword}
            className="gap-2"
          >
            <Send className="h-4 w-4" />
            שלח מייל בדיקה
          </Button>
        </div>
      </form>

      <Dialog open={testOpen} onOpenChange={setTestOpen}>
        <DialogContent dir="rtl" className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>שליחת מייל בדיקה</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="testTo" className="text-base font-medium text-muted-foreground">
              כתובת יעד
            </Label>
            <Input
              id="testTo"
              type="email"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              placeholder="recipient@example.com"
              dir="ltr"
              className="h-10"
              autoFocus
            />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setTestOpen(false)} disabled={testSending}>
              ביטול
            </Button>
            <Button
              onClick={onSendTest}
              disabled={testSending}
              className="bg-blue-600 hover:bg-blue-700 text-white gap-2"
            >
              <Send className="h-4 w-4" />
              {testSending ? 'שולח…' : 'שלח'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
