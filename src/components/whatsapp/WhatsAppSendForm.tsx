'use client';

import {
  forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState,
} from 'react';
import { toast } from 'sonner';
import {
  Send, Loader2, Home, Phone, Wallet, User as UserIcon, AlertTriangle,
  Paperclip,
} from 'lucide-react';
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
import { WHATSAPP_MESSAGE_MAX_FILES } from '@/lib/constants/whatsappAttachments';
import {
  AttachmentPicker, readyAttachmentIds, isUploading, type StagedAttachment,
} from '@/components/whatsapp/AttachmentPicker';
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
  /** {{special}} source — the special/hot-water debt (debtors.hot_water_debt).
   *  The special_debt column is legacy and always 0; never pass it here. */
  hot_water_debt: number;
}

/** Imperative handle so an outer close affordance (Sheet X / overlay, or the
 *  tenant-card "back to details" button) can route through the dirty guard. */
export interface WhatsAppSendFormHandle {
  requestClose: () => void;
}

const FREE_TEXT = '__free__';

interface Props {
  recipient: WhatsAppRecipient;
  /** Bind the ESC listener while the form is the active surface. */
  escActive: boolean;
  /** Actually leave the form (close the sheet / return to details). Called
   *  after the dirty-guard confirm, or immediately when nothing was typed. */
  onClose: () => void;
  /** Fired after a successful send (parent refreshes history / row data). */
  onSent?: () => void;
}

/**
 * The WhatsApp compose surface — recipient summary, phone picker, template
 * picker, message editor, live preview, footer + dirty guard. Rendered both
 * inside the standalone WhatsAppSendPanel sheet (from the debtors table) and
 * inline inside the tenant detail card. Single source of send logic.
 *
 * Mount-fresh contract: parents render with `key={recipient.id}` so switching
 * recipients remounts the form and resets all state — no open/recipient reset
 * effect needed.
 */
export const WhatsAppSendForm = forwardRef<WhatsAppSendFormHandle, Props>(
  function WhatsAppSendForm({ recipient, escActive, onClose, onSent }, ref) {
    const [templates, setTemplates] = useState<WhatsAppTemplate[]>([]);
    const [templateId, setTemplateId] = useState<string>(FREE_TEXT);
    const [content, setContent] = useState('');
    const [sending, setSending] = useState(false);
    const [confirmClose, setConfirmClose] = useState(false);
    const [attachments, setAttachments] = useState<StagedAttachment[]>([]);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    // Staged uploads that never became a message are removed when the form goes
    // away — best-effort, keepalive so it survives the unmount.
    const stagedRef = useRef<StagedAttachment[]>([]);
    useEffect(() => { stagedRef.current = attachments; }, [attachments]);
    useEffect(() => () => {
      for (const a of stagedRef.current) {
        if (a.attachmentId) {
          void fetch(`/api/whatsapp/messages/attachments/${a.attachmentId}`, {
            method: 'DELETE', credentials: 'include', keepalive: true,
          }).catch(() => {});
        }
      }
    }, []);

    // Clean fields hold one local number each; the label comes from the field's
    // semantics (owner / tenant), not the string. Fall back to candidate parsing
    // only for legacy/abnormal values still lurking in the column.
    // Additional owners/tenants from the apartment card ("מקבל הודעות"), loaded
    // once per recipient and appended to the picker below the primary numbers.
    const [extraCandidates, setExtraCandidates] = useState<PhoneCandidate[]>([]);
    const candidates = useMemo(
      () => mergeCandidates(buildRecipientCandidates(recipient), extraCandidates),
      [recipient, extraCandidates],
    );
    const [selectedPhone, setSelectedPhone] = useState<string | null>(
      () => candidates[0]?.phone ?? null,
    );

    const recipientName = recipient.owner_name || recipient.tenant_name || 'ללא שם';
    const selectedCandidate = candidates.find((c) => c.phone === selectedPhone) ?? null;
    const phoneDisplay = selectedCandidate ? formatPhoneDisplay(selectedCandidate.phone) : null;
    const noValidPhone = candidates.length === 0;

    // Load active templates once on mount.
    useEffect(() => {
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
    }, []);

    // Extra apartment-card recipients. Failure is silent: the primary numbers
    // are already in the picker, so a hiccup here must not block a send.
    useEffect(() => {
      let cancelled = false;
      (async () => {
        try {
          const r = await fetch(
            `/api/whatsapp/recipient-phones?debtor_id=${encodeURIComponent(recipient.id)}`,
            { credentials: 'include' },
          );
          if (!r.ok) return;
          const data = (await r.json()) as { phones?: { phone: string; label: string }[] };
          const parsed: PhoneCandidate[] = [];
          for (const p of data.phones ?? []) {
            const clean = cleanPhoneField(p.phone);
            if (clean) parsed.push({ phone: clean, label: p.label });
          }
          if (!cancelled) setExtraCandidates(parsed);
        } catch {
          /* keep the primary numbers only */
        }
      })();
      return () => { cancelled = true; };
    }, [recipient.id]);

    const preview = useMemo(
      () => interpolateTemplate(content, recipient),
      [content, recipient],
    );

    // Files OR text make the form sendable (files may go out with no caption).
    const uploading = isUploading(attachments);
    const readyIds = readyAttachmentIds(attachments);
    const isDirty = content.trim().length > 0 || attachments.length > 0;
    const canSend =
      (content.trim().length > 0 || readyIds.length > 0) && !sending && !uploading && selectedPhone !== null;

    function requestClose() {
      if (sending) return;
      if (isDirty) setConfirmClose(true);
      else onClose();
    }

    useImperativeHandle(ref, () => ({ requestClose }));

    useEscapeKey(escActive && !confirmClose, () => requestClose());
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
      if (!canSend || !selectedPhone) return;
      setSending(true);
      try {
        const tplId = templateId === FREE_TEXT ? null : templateId;
        // The files were uploaded as they were picked; only their ids travel here.
        const res = await fetch('/api/whatsapp/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            debtor_id: recipient.id,
            message: content.trim(),
            template_id: tplId,
            phone: selectedPhone,
            attachment_ids: readyIds,
          }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          error?: string; warning?: string; failed_attachments?: string[];
        };
        if (!res.ok) {
          // Real failure — the form stays open so the text can be edited and sent
          // again. The files, however, are now tied to the failed message row (so
          // it can be resent from the history), so the composer must let them go:
          // re-posting their ids would only be refused.
          if (readyIds.length > 0) {
            setAttachments([]);
            throw new Error(
              `${data.error || `שליחה נכשלה (HTTP ${res.status})`} — הקבצים נשמרו עם ההודעה שנכשלה, אפשר לשלוח אותה שוב מההיסטוריה`,
            );
          }
          throw new Error(data.error || `שליחה נכשלה (HTTP ${res.status})`);
        }
        // 207: the message went out, these files did not.
        if (data.failed_attachments?.length) {
          toast.warning(`ההודעה נשלחה, אך הקבצים הבאים לא נשלחו: ${data.failed_attachments.join(', ')}`);
        } else if (data.warning) toast.warning(data.warning);
        else toast.success('ההודעה נשלחה בוואטסאפ');
        // Sent files belong to the message now — nothing left to clean up.
        setAttachments([]);
        onSent?.();
        onClose();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'שליחה נכשלה');
      } finally {
        setSending(false);
      }
    }

    return (
      <>
        {/* Body */}
        <div className="flex-1 space-y-5 overflow-y-auto bg-slate-50/60 p-5">
          {/* Recipient summary */}
          <div className="grid grid-cols-2 gap-3 rounded-xl border border-slate-200 bg-white p-4 md:grid-cols-4">
            <InfoCell icon={UserIcon} label="נמען" value={recipientName} />
            <InfoCell icon={Home} label="דירה" value={recipient.apartment_number} />
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
              value={formatDebt(recipient.total_debt)}
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
                <SelectValue placeholder="בחר תבנית או כתיבה חופשית">
                  {(value: string | null) => {
                    if (!value || value === FREE_TEXT) return 'כתיבה חופשית';
                    return templates.find((t) => t.id === value)?.name ?? 'תבנית';
                  }}
                </SelectValue>
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
              rows={18}
              className="min-h-48 resize-none"
              disabled={sending}
              dir="rtl"
            />

            {/* Attachments — up to WHATSAPP_MESSAGE_MAX_FILES, uploaded on pick
                to the private bucket and linked to the message on send (§26b). */}
            <AttachmentPicker
              items={attachments}
              onChange={setAttachments}
              disabled={sending}
              maxFiles={WHATSAPP_MESSAGE_MAX_FILES}
              uploadUrl="/api/whatsapp/messages/attachments"
            />
          </div>

          {/* Live preview */}
          <div className="space-y-2">
            <Label className="text-base font-medium text-muted-foreground">תצוגה מקדימה</Label>
            <div className="min-h-[88px] whitespace-pre-wrap rounded-xl border border-emerald-100 bg-emerald-50/40 p-4 text-sm leading-relaxed text-slate-800">
              {preview.trim().length > 0 ? (
                preview
              ) : attachments.length === 0 ? (
                <span className="text-slate-400">ההודעה תוצג כאן לאחר עריכה...</span>
              ) : null}
              {attachments.filter((a) => a.status !== 'error').map((a) => (
                <div key={a.localId} className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
                  <Paperclip className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{a.name}</span>
                </div>
              ))}
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
              variant="approve"
              className="gap-2"
            >
              {sending || uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {sending ? 'שולח…' : uploading ? 'מעלה קבצים…' : 'שלח הודעה'}
            </Button>
          </div>
        </footer>

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
                onClick={() => { setConfirmClose(false); onClose(); }}
                className="bg-destructive text-white hover:bg-destructive/90"
              >
                צא ללא שליחה
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>
    );
  },
);

// Build recipient candidates from the clean phone fields: phone_owner → "בעלים",
// phone_tenant → "שוכר/ת". Labels derive from the field, not the string. If both
// fields are empty/invalid (legacy compound value still lurking), fall back to
// parsePhoneCandidates over the combined raw fields.
/** Append the apartment-card extras, dropping numbers already in the picker. */
function mergeCandidates(primary: PhoneCandidate[], extra: PhoneCandidate[]): PhoneCandidate[] {
  const seen = new Set(primary.map((c) => c.phone));
  const out = [...primary];
  for (const c of extra) {
    if (seen.has(c.phone)) continue;
    seen.add(c.phone);
    out.push(c);
  }
  return out;
}

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
