'use client';

import { useEffect, useState } from 'react';
import { Megaphone, X } from 'lucide-react';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { BroadcastComposeClient } from '@/app/(app)/whatsapp/broadcasts/new/BroadcastComposeClient';
import { BroadcastsHistoryClient } from '@/app/(app)/whatsapp/broadcasts/BroadcastsHistoryClient';
import { BroadcastDetailClient } from '@/app/(app)/whatsapp/broadcasts/[id]/BroadcastDetailClient';

// The WhatsApp broadcast WINDOW — the single entry point, opened from the button
// on the Messages screen. It hosts the existing compose form, the scalable history
// table and the delivery-log view (all reused, unmodified logic) behind two tabs +
// a nested log view — so create / stop / review never leaves this window.
//
// The compose client stays MOUNTED (visually toggled) the whole time the window is
// open, so an active-broadcast card survives a hop into the delivery log or the
// history tab and back — its state is never discarded by navigation.
type Tab = 'compose' | 'history';

export function BroadcastPanel({
  open,
  onOpenChange,
  canEdit,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  canEdit: boolean;
}) {
  const [tab, setTab] = useState<Tab>('compose');
  const [detailId, setDetailId] = useState<string | null>(null);

  // Fresh window each time it opens.
  useEffect(() => {
    if (open) { setTab('compose'); setDetailId(null); }
  }, [open]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="left"
        dir="rtl"
        showCloseButton={false}
        className="flex w-full max-w-full flex-col gap-0 overflow-hidden bg-white p-0 sm:w-[92vw] md:w-[80vw] lg:w-[55vw] lg:min-w-[760px]"
      >
        {/* Header — the window chrome (matches the original broadcast window). */}
        <div className="flex-none bg-gradient-to-bl from-emerald-900 via-emerald-800 to-green-700 px-6 py-5 text-white">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-white/10">
                <Megaphone className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <SheetTitle className="text-xl font-bold text-white">תפוצת WhatsApp</SheetTitle>
                <p className="mt-0.5 text-sm text-white/70">שליחת הודעה לקבוצת נמענים וניהול תפוצות</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              aria-label="סגור"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/25 bg-white/5 text-white transition-colors hover:border-white/50 hover:bg-white/15"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Tabs — hidden while drilled into a delivery log. */}
          {!detailId && (
            <div className="mt-4 inline-flex items-center gap-1 rounded-xl bg-white/10 p-1">
              <TabButton active={tab === 'compose'} onClick={() => setTab('compose')}>תפוצה חדשה</TabButton>
              <TabButton active={tab === 'history'} onClick={() => setTab('history')}>היסטוריית תפוצות</TabButton>
            </div>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto bg-slate-50/60 p-5">
          {/* Compose stays mounted so an active card survives tab/log navigation. */}
          <div className={cn((detailId || tab !== 'compose') && 'hidden')}>
            <BroadcastComposeClient
              embedded
              onOpenDetail={(id) => setDetailId(id)}
              onCancel={() => onOpenChange(false)}
            />
          </div>

          {!detailId && tab === 'history' && (
            <BroadcastsHistoryClient
              canEdit={canEdit}
              embedded
              onOpenDetail={(id) => setDetailId(id)}
              onCreate={() => setTab('compose')}
            />
          )}

          {detailId && (
            <BroadcastDetailClient id={detailId} canEdit={canEdit} onBack={() => setDetailId(null)} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'cursor-pointer rounded-lg px-4 py-1.5 text-sm font-semibold transition-colors',
        active ? 'bg-white text-emerald-800 shadow-sm' : 'bg-transparent text-white/80 hover:bg-white/10',
      )}
    >
      {children}
    </button>
  );
}
