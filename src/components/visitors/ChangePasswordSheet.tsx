'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Lock, X } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Section } from '@/components/side-panel/Section';
import { PanelFooter } from '@/components/side-panel/PanelFooter';
import { PasswordField, PasswordRequirements } from '@/components/auth/PasswordField';
import { isValidPassword } from '@/lib/auth/passwordPolicy';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';

// The guard's own "שינוי סיסמה" (08/11/2026). The system had no such screen and
// a guard has no mailbox for "forgot password", so the visitor-scan screen
// carries this one action. A Sheet, like every edit (DESIGN §12).

interface Props {
  open: boolean;
  onClose: () => void;
}

export function ChangePasswordSheet({ open, onClose }: Props) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [saving, setSaving] = useState(false);

  useEscapeKey(open, () => close());

  function close() {
    if (saving) return;
    setCurrent(''); setNext(''); setAgain('');
    onClose();
  }

  const nextInvalid = next.length > 0 && !isValidPassword(next);
  const mismatch = again.length > 0 && again !== next;
  const canSave = current.length > 0 && isValidPassword(next) && again === next && !saving;

  async function save() {
    if (!canSave) return;
    setSaving(true);
    try {
      const r = await fetch('/api/account/password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ current_password: current, new_password: next }),
      });
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(data.error ?? 'שינוי הסיסמה נכשל');
      toast.success('הסיסמה עודכנה');
      setCurrent(''); setNext(''); setAgain('');
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) close(); }}>
      <SheetContent
        side="left" dir="rtl" showCloseButton={false}
        className="w-full max-w-full p-0 sm:w-[92vw] md:w-[80vw] lg:w-[55vw] lg:min-w-[720px] flex flex-col gap-0 overflow-hidden bg-white"
      >
        <SheetHeader className="flex-none gap-2 bg-gradient-to-bl from-slate-900 via-blue-950 to-blue-900 px-6 py-6 text-white">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <SheetTitle className="text-2xl font-bold text-white">שינוי סיסמה</SheetTitle>
              <p className="mt-1 text-sm text-white/70">הסיסמה החדשה תחול בכניסה הבאה. מכשירים אחרים יתנתקו.</p>
            </div>
            <button
              type="button" onClick={close} aria-label="סגור" disabled={saving}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/25 bg-white/5 text-white transition-colors hover:bg-white/15 hover:border-white/50 disabled:opacity-60"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto bg-slate-50/60 p-5">
          <Section title="סיסמה" icon={Lock} iconTone="blue">
            <div className="space-y-4 py-2">
              <PasswordField id="pw-current" label="סיסמה נוכחית" value={current} onChange={setCurrent} disabled={saving} autoComplete="current-password" />
              <PasswordField id="pw-new" label="סיסמה חדשה" value={next} onChange={setNext} disabled={saving}
                error={nextInvalid ? 'הסיסמה לא עומדת בדרישות' : null} />
              {next.length > 0 && <PasswordRequirements value={next} />}
              <PasswordField id="pw-again" label="הקלד שוב את הסיסמה החדשה" value={again} onChange={setAgain} disabled={saving}
                error={mismatch ? 'הסיסמאות אינן זהות' : null} />
            </div>
          </Section>
        </div>

        <PanelFooter onClose={close} onSave={() => void save()} saveDisabled={!canSave}
          saveLabel={saving ? 'שומר…' : 'שמור סיסמה'} />
      </SheetContent>
    </Sheet>
  );
}
