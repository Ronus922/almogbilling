'use client';

import { useEffect, useState } from 'react';
import { Copy, FlaskConical, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';

/**
 * Test mode of /chip-order (13/11/2026) — inside the "הזמנת צ׳יפים למעלית"
 * card, for chips_orders_manage only (the page renders it only then, and the
 * API checks it again). The switch acts at once — it is not part of the card's
 * "שמור". Switching on (or "צור קישור חדש") makes a fresh secret link and
 * shows it with a copy button; the server keeps only a hash of it, so after a
 * reload the link cannot be shown again — a new one is made instead (the old
 * one stops working). Switching off kills the link.
 */
interface State {
  enabled: boolean;
  linkCreatedAt: string | null;
}

const WHEN = new Intl.DateTimeFormat('he-IL', {
  timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

export function ChipOrderTestModeSection({ canEdit }: { canEdit: boolean }) {
  const [state, setState] = useState<State | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/chip-orders/test-mode', { credentials: 'include' });
        if (!r.ok) throw new Error('failed');
        const d = (await r.json()) as { state: State };
        if (!cancelled) setState(d.state);
      } catch {
        if (!cancelled) toast.error('טעינת מצב הבדיקה נכשלה — רעננו את הדף');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function post(action: 'enable' | 'regenerate' | 'disable') {
    setBusy(true);
    try {
      const r = await fetch('/api/chip-orders/test-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action }),
      });
      const d = (await r.json().catch(() => ({}))) as { state?: State; link?: string; error?: string };
      if (!r.ok || !d.state) throw new Error(d.error ?? 'הפעולה נכשלה');
      setState(d.state);
      setLink(d.link ?? null);
      toast.success(
        action === 'disable' ? 'מצב בדיקה כובה — הקישור הפסיק לעבוד'
          : action === 'enable' ? 'מצב בדיקה הודלק — העתיקו את הקישור'
            : 'נוצר קישור חדש — הקודם הפסיק לעבוד',
      );
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      toast.success('הקישור הועתק');
    } catch {
      toast.error('ההעתקה נכשלה — סמנו את הקישור והעתיקו ידנית');
    }
  }

  const disabled = busy || !canEdit || state === null;

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-violet-200 bg-violet-50/40 p-4" data-testid="chip-order-test-mode">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-violet-100 text-violet-700">
            <FlaskConical className="h-[18px] w-[18px]" />
          </span>
          <div className="min-w-0">
            <p className="font-semibold text-slate-900">מצב בדיקה</p>
            <p className="mt-0.5 text-[12.5px] text-slate-500">
              קישור סודי שפותח את /chip-order גם בלי Grow: כל התהליך כמו בהזמנה אמיתית, ובמקום תשלום — „סיים הזמנת בדיקה”, בלי חיוב.
              ההזמנה מסומנת „בדיקה” ב-/chips ולא נספרת. השינוי נשמר מיד.
            </p>
          </div>
        </div>
        <Switch
          checked={state?.enabled ?? false}
          onCheckedChange={(v) => void post(v === true ? 'enable' : 'disable')}
          disabled={disabled}
          aria-label="מצב בדיקה"
        />
      </div>

      {state?.enabled && (
        <div className="flex flex-col gap-3">
          {link ? (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                readOnly
                value={link}
                dir="ltr"
                onFocus={(e) => e.currentTarget.select()}
                aria-label="קישור הבדיקה"
                data-testid="chip-order-test-link"
                className="h-10 flex-1 bg-white px-3 py-2 font-mono text-[13px]"
              />
              <Button type="button" onClick={() => void copy()} className="h-10 gap-2 px-4 py-2">
                <Copy className="h-4 w-4" />
                העתק
              </Button>
            </div>
          ) : (
            <p className="rounded-md bg-white/70 p-3 text-[12.5px] text-slate-600">
              מצב בדיקה פעיל{state.linkCreatedAt ? ` (הקישור נוצר ${WHEN.format(new Date(state.linkCreatedAt))})` : ''}. הקישור מוצג רק כשהוא
              נוצר, והשרת שומר ממנו רק טביעה (hash) — כדי לראות קישור, צרו קישור חדש (הקודם יפסיק לעבוד).
            </p>
          )}
          {link && (
            <p className="text-[12px] text-slate-500">הקישור מוצג עכשיו בלבד. אחרי רענון אפשר רק ליצור קישור חדש.</p>
          )}
          {canEdit && (
            <div className="flex justify-start">
              <Button type="button" variant="outline" onClick={() => void post('regenerate')} disabled={disabled} className="h-10 gap-2 px-4 py-2">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                צור קישור חדש
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
