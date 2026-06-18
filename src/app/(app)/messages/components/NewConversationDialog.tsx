'use client';

import { useEffect, useState } from 'react';
import { Phone, User, Search, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatPhoneDisplay } from '@/lib/phone';
import { normalizePhone, cleanPhoneField, WhatsAppError } from '@/lib/whatsapp';
import type { Conversation } from '@/types/whatsapp';

interface DebtorResult {
  id: string;
  apartment_number: string;
  owner_name: string | null;
  tenant_name: string | null;
  phone_owner: string | null;
  phone_tenant: string | null;
  is_archived: boolean;
}

type Mode = 'phone' | 'debtor';

function buildConversation(args: {
  phoneIntl: string;
  debtor?: DebtorResult | null;
}): Conversation {
  const local = '0' + args.phoneIntl.slice(3);
  const d = args.debtor;
  const name = d ? (d.owner_name || d.tenant_name || '').trim() || null : null;
  // Match the dialed number against the debtor's phone fields to label the role.
  const convkey = args.phoneIntl.replace(/\D+/g, '').slice(-9);
  const last9 = (s: string | null) => (s || '').replace(/\D+/g, '').slice(-9);
  let role: Conversation['role'] = null;
  if (d) {
    if (last9(d.phone_owner) === convkey) role = 'owner';
    else if (last9(d.phone_tenant) === convkey) role = 'tenant';
  }
  return {
    chat_id: `${args.phoneIntl}@c.us`,
    phone: local,
    is_group: false,
    debtor_id: d?.id ?? null,
    display_name: name,
    apartment_number: d?.apartment_number ?? null,
    role,
    tenant_name: d?.tenant_name ?? null,
    last_content: null,
    last_type: 'text',
    last_direction: 'sent',
    last_at: new Date().toISOString(),
    unread: 0,
    avatar_url: null,
  };
}

export function NewConversationDialog({
  open,
  onOpenChange,
  onStart,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onStart: (c: Conversation) => void;
}) {
  const [mode, setMode] = useState<Mode>('phone');
  const [phone, setPhone] = useState('');
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DebtorResult[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (open) {
      setMode('phone');
      setPhone('');
      setPhoneError(null);
      setQuery('');
      setResults([]);
    }
  }, [open]);

  // Debounced debtor search.
  useEffect(() => {
    if (mode !== 'debtor') return;
    const term = query.trim();
    if (term.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/debtors/search?q=${encodeURIComponent(term)}`, { credentials: 'include' });
        if (!r.ok) throw new Error('failed');
        const data = (await r.json()) as DebtorResult[];
        if (!cancelled) setResults(data);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, mode]);

  function startByPhone() {
    setPhoneError(null);
    try {
      const { phone: intl } = normalizePhone(phone);
      onStart(buildConversation({ phoneIntl: intl }));
    } catch (err) {
      setPhoneError(err instanceof WhatsAppError ? err.message : 'מספר טלפון לא תקין');
    }
  }

  function startByDebtor(d: DebtorResult) {
    const local = cleanPhoneField(d.phone_owner) ?? cleanPhoneField(d.phone_tenant);
    if (!local) {
      toast.error('לדייר זה אין מספר טלפון תקין');
      return;
    }
    try {
      const { phone: intl } = normalizePhone(local);
      onStart(buildConversation({ phoneIntl: intl, debtor: d }));
    } catch {
      toast.error('מספר הטלפון של הדייר אינו תקין');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent dir="rtl" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>שיחה חדשה</DialogTitle>
        </DialogHeader>

        {/* Mode toggle */}
        <div className="flex gap-2">
          <ModeButton active={mode === 'phone'} onClick={() => setMode('phone')} icon={Phone}>
            לפי טלפון
          </ModeButton>
          <ModeButton active={mode === 'debtor'} onClick={() => setMode('debtor')} icon={User}>
            לפי דייר
          </ModeButton>
        </div>

        {mode === 'phone' ? (
          <div className="space-y-2">
            <Label htmlFor="new-chat-phone" className="text-sm font-medium text-muted-foreground">
              מספר טלפון
            </Label>
            <Input
              id="new-chat-phone"
              value={phone}
              onChange={(e) => { setPhone(e.target.value); setPhoneError(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') startByPhone(); }}
              placeholder="052-1234567"
              inputMode="tel"
              dir="ltr"
              className={cn('h-10', phoneError && 'border-red-400 bg-red-50 focus-visible:ring-red-200')}
            />
            {phoneError && (
              <p className="text-[12px] font-semibold text-red-500">⚠️ {phoneError}</p>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <div className="relative">
              <Search className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="חיפוש לפי שם או דירה"
                className="h-10 pe-9"
                autoFocus
              />
            </div>
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {searching ? (
                <div className="flex items-center justify-center py-6 text-slate-400">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
              ) : results.length === 0 ? (
                <p className="py-6 text-center text-xs text-slate-400">
                  {query.trim().length < 2 ? 'הקלד לפחות 2 תווים' : 'לא נמצאו דיירים'}
                </p>
              ) : (
                results.map((d) => {
                  const local = cleanPhoneField(d.phone_owner) ?? cleanPhoneField(d.phone_tenant);
                  return (
                    <button
                      key={d.id}
                      type="button"
                      onClick={() => startByDebtor(d)}
                      className="flex w-full items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white p-2.5 text-start transition-colors hover:bg-slate-50"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-slate-900">
                          {(d.owner_name || d.tenant_name || 'ללא שם').trim()}
                        </span>
                        <span className="text-xs text-slate-500">דירה {d.apartment_number}</span>
                      </span>
                      <span dir="ltr" className="shrink-0 text-xs tabular-nums text-slate-500">
                        {local ? formatPhoneDisplay(local) : 'אין טלפון'}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>ביטול</Button>
          {mode === 'phone' && (
            <Button onClick={startByPhone} variant="approve" className="gap-2">
              פתח שיחה
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ModeButton({
  active, onClick, icon: Icon, children,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Phone;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex flex-1 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold transition-colors',
        active
          ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
      )}
    >
      <Icon className="h-4 w-4" /> {children}
    </button>
  );
}
