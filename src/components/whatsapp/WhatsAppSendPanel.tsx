'use client';

import { useRef } from 'react';
import { MessageCircle, X } from 'lucide-react';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import {
  WhatsAppSendForm, type WhatsAppRecipient, type WhatsAppSendFormHandle,
} from './WhatsAppSendForm';

export type { WhatsAppRecipient } from './WhatsAppSendForm';

/**
 * Standalone WhatsApp send sheet — used from the debtors table row action.
 * A thin wrapper that supplies the green header + close affordances around the
 * shared {@link WhatsAppSendForm}. The same form renders inline inside the
 * tenant detail card; all send logic lives in one place.
 */
export function WhatsAppSendPanel({
  open,
  recipient,
  onOpenChange,
  onSent,
}: {
  open: boolean;
  recipient: WhatsAppRecipient | null;
  onOpenChange: (open: boolean) => void;
  onSent?: () => void;
}) {
  const formRef = useRef<WhatsAppSendFormHandle | null>(null);
  const recipientName = recipient?.owner_name || recipient?.tenant_name || 'ללא שם';

  // Close affordances (X / overlay) route through the form's dirty guard when a
  // recipient is present; otherwise close directly.
  function requestClose() {
    if (formRef.current) formRef.current.requestClose();
    else onOpenChange(false);
  }

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) requestClose(); else onOpenChange(o); }}>
      <SheetContent
        side="left"
        dir="rtl"
        showCloseButton={false}
        className="w-full p-0 sm:w-[55vw] md:min-w-[720px] flex flex-col gap-0 overflow-hidden bg-white"
      >
        {/* Header */}
        <div className="flex-none bg-gradient-to-bl from-emerald-900 via-emerald-800 to-green-700 px-6 py-5 text-white">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-white/10">
                <MessageCircle className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <SheetTitle className="text-xl font-bold text-white">שליחת הודעת WhatsApp</SheetTitle>
                <p className="mt-0.5 truncate text-sm text-white/70">
                  {recipientName}
                  {recipient && <span className="mx-2 text-white/40">•</span>}
                  {recipient && `דירה ${recipient.apartment_number}`}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={requestClose}
              aria-label="סגור"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/25 bg-white/5 text-white transition-colors hover:border-white/50 hover:bg-white/15"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {recipient && (
          <WhatsAppSendForm
            key={recipient.id}
            ref={formRef}
            recipient={recipient}
            escActive={open}
            onClose={() => onOpenChange(false)}
            onSent={onSent}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}
