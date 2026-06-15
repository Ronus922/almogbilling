'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  MessageCircle, Plug, ExternalLink, Inbox, RefreshCw, CheckCircle2, AlertCircle, Download,
} from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { GreenApiSettingsPublic, GreenApiWebhookStatus } from '@/types/whatsapp';

export function GreenApiSettingsCard() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [instanceId, setInstanceId] = useState('');
  const [token, setToken] = useState('');
  const [hasToken, setHasToken] = useState(false);
  const [testing, setTesting] = useState(false);

  // Inbound (phase 2)
  const [webhook, setWebhook] = useState<GreenApiWebhookStatus | null>(null);
  const [registering, setRegistering] = useState(false);
  const [pulling, setPulling] = useState(false);

  const refreshWebhook = useCallback(async () => {
    try {
      const r = await fetch('/api/settings/green-api/webhook');
      if (!r.ok) return;
      setWebhook((await r.json()) as GreenApiWebhookStatus);
    } catch {
      /* non-fatal — status just stays unknown */
    }
  }, []);

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
        if (d.hasToken) void refreshWebhook();
      } catch {
        if (!cancelled) toast.error('טעינת הגדרות WhatsApp נכשלה');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [refreshWebhook]);

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
      void refreshWebhook();
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

  async function onRegister() {
    if (registering) return;
    setRegistering(true);
    try {
      const r = await fetch('/api/settings/green-api/webhook', { method: 'POST' });
      const data = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok) throw new Error(data.error ?? 'הרישום נכשל');
      toast.success('קבלת הודעות הופעלה — האינסטנס יתאתחל לרגע');
      await refreshWebhook();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setRegistering(false);
    }
  }

  async function onPull() {
    if (pulling) return;
    setPulling(true);
    try {
      const r = await fetch('/api/whatsapp/pull', { method: 'POST' });
      const data = (await r.json()) as { ok?: boolean; received?: number; skipped?: number; error?: string };
      if (!r.ok) throw new Error(data.error ?? 'משיכת ההודעות נכשלה');
      toast.success(`נקלטו ${data.received ?? 0} הודעות חדשות · דולגו ${data.skipped ?? 0}`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setPulling(false);
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
          <p className="mt-1 text-sm text-slate-500">Green API — שליחה וקבלה של הודעות</p>
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
            variant="approve"
            disabled={loading || saving}
            className="gap-2"
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

      {/* Inbound — receive messages */}
      <div className="mt-6 space-y-3 rounded-xl border border-slate-200 bg-slate-50/60 p-4">
        <div className="flex items-start gap-2.5">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-sky-50 text-sky-600">
            <Inbox className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-slate-900">קבלת הודעות נכנסות</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              רישום webhook אצל Green API + משיכה ידנית כגיבוי.
            </p>
          </div>
        </div>

        {/* Status row */}
        <WebhookStatusRow status={webhook} hasToken={hasToken} />

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            onClick={onRegister}
            disabled={!hasToken || registering}
            className={cn('gap-2 text-white', webhook?.registered
              ? 'bg-slate-600 hover:bg-slate-700'
              : 'bg-sky-600 hover:bg-sky-700')}
          >
            <RefreshCw className={cn('h-4 w-4', registering && 'animate-spin')} />
            {registering ? 'רושם…' : webhook?.registered ? 'רישום מחדש' : 'הפעל קבלת הודעות'}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={onPull}
            disabled={!hasToken || pulling}
            className="gap-2"
          >
            <Download className={cn('h-4 w-4', pulling && 'animate-spin')} />
            {pulling ? 'מושך…' : 'משוך הודעות'}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function WebhookStatusRow({ status, hasToken }: { status: GreenApiWebhookStatus | null; hasToken: boolean }) {
  if (!hasToken) {
    return <p className="text-xs text-slate-400">שמור חיבור Green API כדי להפעיל קבלת הודעות.</p>;
  }
  if (!status) {
    return <div className="h-5 w-40 rounded bg-slate-200/70 animate-pulse" />;
  }
  if (status.registered) {
    return (
      <p className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-700">
        <CheckCircle2 className="h-4 w-4" />
        רשום ופעיל
      </p>
    );
  }
  return (
    <p className="inline-flex items-center gap-1.5 text-sm font-medium text-amber-700">
      <AlertCircle className="h-4 w-4" />
      {status.incomingEnabled ? 'webhook מצביע לכתובת אחרת' : 'לא רשום — קבלת הודעות כבויה'}
    </p>
  );
}
