'use client';

// "התחברויות לפורטל" tab — this apartment's slice of the login log, plus a
// banner for each of its phones that is locked out right now, with "שחרר חסימה".
//
// The log itself is the shared PortalLogTable (the same component /admin/portal-log
// renders), with the apartment column dropped: every row here is this apartment.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { LockOpen, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatPhoneDisplay } from '@/lib/phone';
import { e164ToLocal } from '@/lib/portal/phone';
import type { PortalLockout, PortalLoginEvent } from '@/lib/types/portal';
import { Section } from './Section';
import { PortalLogTable } from '@/components/portal/PortalLogTable';

const timeFmt = new Intl.DateTimeFormat('he-IL', {
  hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem',
});

export function PortalLoginsTab({ apartmentNumber, canEdit }: {
  apartmentNumber: string;
  canEdit: boolean;
}) {
  const [events, setEvents] = useState<PortalLoginEvent[] | null>(null);
  const [lockouts, setLockouts] = useState<PortalLockout[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [releasing, setReleasing] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/apartments/${encodeURIComponent(apartmentNumber)}/portal-log`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { events: PortalLoginEvent[]; lockouts: PortalLockout[] };
      setEvents(data.events);
      setLockouts(data.lockouts);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [apartmentNumber]);

  useEffect(() => { void load(); }, [load]);

  async function unlock(phoneE164: string) {
    setReleasing(phoneE164);
    try {
      const res = await fetch(`/api/apartments/${encodeURIComponent(apartmentNumber)}/portal-unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ phone: phoneE164 }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      toast.success('החסימה שוחררה');
      await load();
    } catch (err) {
      toast.error(`השחרור נכשל: ${(err as Error).message}`);
    } finally {
      setReleasing(null);
    }
  }

  return (
    <div className="space-y-4">
      {lockouts.map((l) => (
        <div
          key={l.id}
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900"
        >
          <span className="flex items-center gap-2 font-semibold">
            <ShieldAlert className="h-4 w-4 shrink-0 text-red-600" aria-hidden />
            <span dir="ltr" className="font-num tabular-nums">
              {formatPhoneDisplay(e164ToLocal(l.phone_e164)) ?? l.phone_e164}
            </span>
            <span>
              חסום עד {timeFmt.format(new Date(l.locked_until))} (מדרגה {l.tier})
            </span>
          </span>
          {canEdit && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => unlock(l.phone_e164)}
              disabled={releasing === l.phone_e164}
              className="gap-2"
            >
              <LockOpen className="h-4 w-4" aria-hidden />
              שחרר חסימה
            </Button>
          )}
        </div>
      ))}

      <Section
        title="התחברויות לפורטל"
        icon={ShieldCheck}
        iconTone="violet"
        subtitle={events ? `${events.length} אירועים אחרונים` : undefined}
      >
        <div className="py-2">
          {error ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
              שגיאה בטעינת הלוג: {error}
            </div>
          ) : !events ? (
            <div className="h-40 animate-pulse rounded-xl bg-muted/60" />
          ) : (
            <PortalLogTable events={events} showApartment={false} />
          )}
        </div>
      </Section>
    </div>
  );
}
