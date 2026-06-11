'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { MessageCircle, Plug, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import type { GreenApiSettingsPublic } from '@/types/whatsapp';

export function GreenApiSettingsCard() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [instanceId, setInstanceId] = useState('');
  const [token, setToken] = useState('');
  const [hasToken, setHasToken] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/settings/green-api');
        if (!r.ok) throw new Error('failed');
        const d = (await r.json()) as GreenApiSettingsPublic;
        if (cancelled) return;
        setInstanceId(d.instanceId ?? '');
        setHasToken(Boolean(d.hasToken));
      } catch {
        if (!cancelled) toast.error('טעינת הגדרות WhatsApp נכשלה');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (saving) return;

    const trimmedId = instanceId.trim();
    const trimmedToken = token.trim();

    if (!/^\d{6,}$/.test(trimmedId)) {
      toast.error('מזהה Instance לא תקין (ספרות בלבד)');
      return;
    }
    if (!hasToken && !trimmedToken) {
      toast.error('יש להזין טוקן');
      return;
    }

    setSaving(true);
    try {
      const r = await fetch('/api/settings/green-api', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instanceId: trimmedId, token: trimmedToken || undefined }),
      });
      const data = (await r.json()) as { error?: string };
      if (!r.ok) throw new Error(data.error ?? 'שמירה נכשלה');
      toast.success('הגדרות WhatsApp נשמרו');
      setToken('');
      setHasToken(true);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function onTest() {
    if (testing) return;
    setTesting(true);
    try {
      const r = await fetch('/api/settings/green-api/test', { method: 'POST' });
      const data = (await r.json()) as { ok?: boolean; stateInstance?: string; error?: string };
      if (!r.ok) throw new Error(data.error ?? 'בדיקת החיבור נכשלה');
      if (data.ok) {
        toast.success('החיבור תקין — האינסטנס מאומת (authorized)');
      } else {
        toast.warning(`החיבור עובד אך האינסטנס לא מאומת: ${data.stateInstance ?? 'unknown'}`);
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setTesting(false);
    }
  }

  return (
    <Card className="ring-1 ring-slate-200/70 shadow-[0_1px_2px_rgba(15,23,42,0.04)] p-6">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-emerald-50 text-emerald-600">
          <MessageCircle className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-slate-900">חיבור WhatsApp</h2>
          <p className="mt-1 text-sm text-slate-500">Green API — שליחת הודעות יוצאות</p>
        </div>
      </div>

      <form onSubmit={onSave} className="mt-6 flex flex-col gap-5" noValidate>
        <div className="space-y-2">
          <Label htmlFor="greenInstanceId" className="text-base font-medium text-muted-foreground">
            מזהה Instance
          </Label>
          <Input
            id="greenInstanceId"
            value={instanceId}
            onChange={(e) => setInstanceId(e.target.value)}
            placeholder="1101000001"
            dir="ltr"
            disabled={loading || saving}
            className="h-10"
            required
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="greenToken" className="text-base font-medium text-muted-foreground">
            API Token
          </Label>
          <Input
            id="greenToken"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={hasToken ? '••••••••••••••••' : 'הדבק את ה-API Token מ-Green API'}
            dir="ltr"
            disabled={loading || saving}
            className="h-10"
            autoComplete="off"
          />
          <a
            href="https://console.green-api.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-emerald-600 hover:underline"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            קונסולת Green API
          </a>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-2">
          <Button
            type="submit"
            disabled={loading || saving}
            className="bg-emerald-600 hover:bg-emerald-700 text-white gap-2"
          >
            {saving ? 'שומר…' : 'שמור'}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={onTest}
            disabled={loading || saving || testing || !hasToken}
            className="gap-2"
          >
            <Plug className="h-4 w-4" />
            {testing ? 'בודק…' : 'בדיקת חיבור'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
