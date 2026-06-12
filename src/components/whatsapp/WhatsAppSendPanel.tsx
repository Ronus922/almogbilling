'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  MessageCircle, X, Send, Loader2, Home, Phone, Wallet, User as UserIcon, AlertTriangle,
} from 'lucide-react';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { formatPhoneDisplay } from '@/lib/phone';
import { parsePhoneCandidates, cleanPhoneField, type PhoneCandidate } from '@/lib/whatsapp';
import {
  interpolateTemplate, formatDebt, TEMPLATE_PLACEHOLDERS,
} from '@/lib/whatsapp-template';
import type { WhatsAppTemplate } from '@/types/whatsapp';

export interface WhatsAppRecipient {
  id: string;
  apartment_number: string;
  owner_name: string | null;
  tenant_name: string | null;
  phone_owner: string | null;
  phone_tenant: string | null;
  total_debt: number;
  management_fees: number;
  special_debt: number;
}

const FREE_TEXT = '__free__';

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
  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([]);
  const [templateId, setTemplateId] = useState<string>(FREE_TEXT);
  const [content, setContent] = useState('');
  const [sending, setSending] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [candidates, setCandidates] = useState<PhoneCandidate[]>([]);
  const [selectedPhone, setSelectedPhone] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const recipientName = recipient?.owner_name || recipient?.tenant_name || 'ללא שם';
  const selectedCandidate = candidates.find((c) => c.phone === selectedPhone) ?? null;
  const phoneDisplay = selectedCandidate ? formatPhoneDisplay(selectedCandidate.phone) : null;
  const noValidPhone = candidates.length === 0;

  // Load active templates + reset state each time the panel opens.
  useEffect(() => {
    if (!open || !recipient) return;
    setTemplateId(FREE_TEXT);
    setContent('');
    setSending(false);
    setConfirmClose(false);
    // Primary path: clean fields hold one local number each — label comes from
    // the field's semantics (owner / tenant), not the string. Fall back to
    // parsePhoneCandidates only for legacy/abnormal values still in the field.
    const cands = buildRecipientCandidates(recipient);
    setCandidates(cands);
    setSelectedPhone(cands[0]?.phone ?? null);
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/whatsapp/templates', { credentials: 'include' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as WhatsAppTemplate[];
        if (!cancelled) setTemplates(data);
      } catch {
        if (!cancelled) toast.error('טעינת התבניות נכשלה');
      }
    })();
    return () => { cancelled = true; };
  }, [open, recipient]);

  const preview = useMemo(
    () => (recipient ? interpolateTemplate(content, recipient) : content),
    [content, recipient],
  );

  const isDirty = content.trim().length > 0;
  const canSend = isDirty && !sending && Boolean(recipient) && selectedPhone !== null;

  function requestClose() {
    if (sending) return;
    if (isDirty) setConfirmClose(true);
    else onOpenChange(false);
  }

  useEscapeKey(open && !confirmClose, () => requestClose());
  useEscapeKey(confirmClose, () => setConfirmClose(false));

  function selectTemplate(value: string | null) {
    const next = value ?? FREE_TEXT;
    setTemplateId(next);
    if (next === FREE_TEXT) {
      setContent('');
      return;
    }
    const tpl = templates.find((t) => t.id === next);
    if (tpl) setContent(tpl.content);
  }

  function insertPlaceholder(token: string) {
    const el = textareaRef.current;
    if (!el) {
      setContent((c) => c + token);
      return;
    }
    const start = el.selectionStart ?? content.length;
    const end = el.selectionEnd ?? content.length;
    const next = content.slice(0, start) + token + content.slice(end);
    setContent(next);
    // Restore caret just after the inserted token.
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  }

  async function handleSend() {
    if (!canSend || !recipient || !selectedPhone) return;
    setSending(true);
    try {
      const res = await fetch('/api/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          debtor_id: recipient.id,
          message: content.trim(),
          template_id: templateId === FREE_TEXT ? null : templateId,
          phone: selectedPhone,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; warning?: string };
      if (!res.ok) {
        // Real failure — keep the panel open so the user can retry / edit.
        throw new Error(data.error || `שליחה נכשלה (HTTP ${res.status})`);
      }
      if (data.warning) toast.warning(data.warning);
      else toast.success('ההודעה נשלחה בוואטסאפ');
      onSent?.();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'שליחה נכשלה');
    } finally {
      setSending(false);
    }
  }

  return (
    <>
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

          {/* Body */}
          <div className="flex-1 space-y-5 overflow-y-auto bg-slate-50/60 p-5">
            {/* Recipient summary */}
            <div className="grid grid-cols-2 gap-3 rounded-xl border border-slate-200 bg-white p-4 md:grid-cols-4">
              <InfoCell icon={UserIcon} label="נמען" value={recipientName} />
              <InfoCell icon={Home} label="דירה" value={recipient?.apartment_number ?? '—'} />
              <InfoCell
                icon={Phone}
                label="טלפון"
                value={phoneDisplay ?? '—'}
                ltr
                tone={phoneDisplay ? undefined : 'muted'}
              />
              <InfoCell
                icon={Wallet}
                label="חוב"
                value={formatDebt(recipient?.total_debt ?? 0)}
                ltr
                tone="danger"
              />
            </div>

            {/* Recipient number — picker when several, notice when none */}
            {noValidPhone ? (
              <div className="flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>לא נמצא מספר טלפון תקין לחייב זה. לא ניתן לשלוח הודעה.</span>
              </div>
            ) : candidates.length > 1 ? (
              <div className="space-y-1.5">
                <Label className="text-base font-medium text-muted-foreground">בחירת נמען</Label>
                <div role="radiogroup" className="space-y-2">
                  {candidates.map((c) => {
                    const checked = c.phone === selectedPhone;
                    return (
                      <label
                        key={c.phone}
                        className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition-colors ${
                          checked ? 'border-emerald-300 bg-emerald-50/60' : 'border-slate-200 bg-white hover:bg-slate-50'
                        }`}
                      >
                        <input
                          type="radio"
                          name="wa-recipient"
                          value={c.phone}
                          checked={checked}
                          onChange={() => setSelectedPhone(c.phone)}
                          disabled={sending}
                          className="h-4 w-4 accent-emerald-600"
                        />
                        <span className="text-sm font-bold text-slate-900 tabular-nums" dir="ltr">
                          {formatPhoneDisplay(c.phone)}
                        </span>
                        {c.label && (
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">
                            {c.label}
                          </span>
                        )}
                      </label>
                    );
                  })}
                </div>
              </div>
            ) : selectedCandidate?.label ? (
              <p className="text-xs text-slate-500">
                נשלח אל <span className="font-semibold text-slate-700">{selectedCandidate.label}</span>
                {' · '}
                <span dir="ltr" className="tabular-nums">{phoneDisplay}</span>
              </p>
            ) : null}

            {/* Template picker */}
            <div className="space-y-1.5">
              <Label className="text-base font-medium text-muted-foreground">תבנית</Label>
              <Select value={templateId} onValueChange={selectTemplate} disabled={sending}>
                <SelectTrigger className="w-full data-[size=default]:h-10">
                  <SelectValue placeholder="בחר תבנית או כתיבה חופשית" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={FREE_TEXT}>כתיבה חופשית</SelectItem>
                  {templates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Message editor */}
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label htmlFor="wa-message" className="text-base font-medium text-muted-foreground">
                  תוכן ההודעה
                </Label>
                <div className="flex flex-wrap items-center gap-1.5">
                  {TEMPLATE_PLACEHOLDERS.map((p) => (
                    <button
                      key={p.token}
                      type="button"
                      onClick={() => insertPlaceholder(p.token)}
                      disabled={sending}
                      className="inline-flex items-center rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700 transition-colors hover:bg-emerald-100 disabled:opacity-50"
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
              <Textarea
                id="wa-message"
                ref={textareaRef}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="כתוב הודעה, או בחר תבנית ולחץ על תגית להוספה בנקודת הסמן..."
                rows={6}
                className="resize-none"
                disabled={sending}
                dir="rtl"
              />
            </div>

            {/* Live preview */}
            <div className="space-y-2">
              <Label className="text-base font-medium text-muted-foreground">תצוגה מקדימה</Label>
              <div className="min-h-[88px] whitespace-pre-wrap rounded-xl border border-emerald-100 bg-emerald-50/40 p-4 text-sm leading-relaxed text-slate-800">
                {preview.trim().length > 0
                  ? preview
                  : <span className="text-slate-400">ההודעה תוצג כאן לאחר עריכה...</span>}
              </div>
            </div>
          </div>

          {/* Footer */}
          <footer className="flex-none border-t border-slate-200 bg-white px-5 py-3">
            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="outline" onClick={requestClose} disabled={sending}>
                ביטול
              </Button>
              <Button
                type="button"
                onClick={handleSend}
                disabled={!canSend}
                className="gap-2 bg-emerald-600 text-white hover:bg-emerald-700"
              >
                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                {sending ? 'שולח…' : 'שלח הודעה'}
              </Button>
            </div>
          </footer>
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>לצאת ללא שליחה?</AlertDialogTitle>
            <AlertDialogDescription>
              כתבת הודעה שלא נשלחה. אם תצא עכשיו, התוכן יאבד.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>חזור לעריכה</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { setConfirmClose(false); onOpenChange(false); }}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              צא ללא שליחה
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// Build recipient candidates from the clean phone fields: phone_owner → "בעלים",
// phone_tenant → "שוכר/ת". Labels derive from the field, not the string. If both
// fields are empty/invalid (legacy compound value still lurking), fall back to
// parsePhoneCandidates over the combined raw fields.
function buildRecipientCandidates(r: WhatsAppRecipient): PhoneCandidate[] {
  const owner = cleanPhoneField(r.phone_owner);
  const tenant = cleanPhoneField(r.phone_tenant);
  const primary: PhoneCandidate[] = [];
  if (owner) primary.push({ phone: owner, label: 'בעלים' });
  if (tenant && tenant !== owner) primary.push({ phone: tenant, label: 'שוכר/ת' });
  if (primary.length > 0) return primary;
  return parsePhoneCandidates(`${r.phone_owner ?? ''} ${r.phone_tenant ?? ''}`);
}

function InfoCell({
  icon: Icon, label, value, ltr, tone,
}: {
  icon: typeof Home;
  label: string;
  value: string;
  ltr?: boolean;
  tone?: 'danger' | 'muted';
}) {
  const valueTone =
    tone === 'danger' ? 'text-red-600' : tone === 'muted' ? 'text-slate-400' : 'text-slate-900';
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-xs text-slate-500">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div
        className={`mt-0.5 truncate text-sm font-bold tabular-nums ${valueTone}`}
        dir={ltr ? 'ltr' : undefined}
      >
        {value}
      </div>
    </div>
  );
}
