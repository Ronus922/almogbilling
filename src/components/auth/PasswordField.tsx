'use client';

// Shared password input (show/hide toggle) + a live requirements checklist,
// reusing the single-source-of-truth policy in @/lib/auth/passwordPolicy.
// Used by the admin user create/edit panels. (The public AcceptInviteForm keeps
// its own inline copy — left untouched to avoid risk to the working auth flow.)

import { useState } from 'react';
import { Eye, EyeOff, Check, Circle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { passwordRequirements } from '@/lib/auth/passwordPolicy';

export function PasswordField({
  id,
  label,
  value,
  onChange,
  disabled,
  error,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  error?: string | null;
  placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-base font-medium text-muted-foreground">{label}</Label>
      <div className="relative">
        <Input
          id={id}
          type={show ? 'text' : 'password'}
          autoComplete="new-password"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          dir="ltr"
          placeholder={placeholder}
          className={cn('h-10 pe-9', error && 'border-red-400 bg-red-50 focus-visible:ring-red-200')}
        />
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          tabIndex={-1}
          aria-label={show ? 'הסתר סיסמה' : 'הצג סיסמה'}
          className="hit-44 absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
      {error && (
        <p className="text-[12px] font-semibold text-red-500 text-start">⚠️ {error}</p>
      )}
    </div>
  );
}

export function PasswordRequirements({ value }: { value: string }) {
  const r = passwordRequirements(value);
  return (
    <ul className="space-y-1 text-xs">
      <Req ok={r.length}>לפחות 8 תווים</Req>
      <Req ok={r.letter}>אות אחת לפחות</Req>
      <Req ok={r.digit}>ספרה אחת לפחות</Req>
    </ul>
  );
}

function Req({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className={cn('flex items-center gap-2', ok ? 'text-emerald-600' : 'text-muted-foreground')}>
      {ok ? <Check className="h-3.5 w-3.5" /> : <Circle className="h-3 w-3" />}
      <span>{children}</span>
    </li>
  );
}
