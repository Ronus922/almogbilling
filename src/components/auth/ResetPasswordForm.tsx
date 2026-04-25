'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Eye, EyeOff, Check, Circle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';

const reqs = (p: string) => ({
  length: p.length >= 8,
  letter: /[a-zA-Z֐-׿]/.test(p),
  digit: /\d/.test(p),
});

export function ResetPasswordForm({ token }: { token: string | null }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show1, setShow1] = useState(false);
  const [show2, setShow2] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tokenInvalid, setTokenInvalid] = useState(false);

  if (!token || tokenInvalid) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-extrabold">בחירת סיסמה חדשה</h1>
        <Alert variant="destructive">
          <AlertDescription>הקישור פג תוקף או לא תקין.</AlertDescription>
        </Alert>
        <Link href="/forgot-password" className="text-sm text-primary hover:underline">
          שלחי קישור חדש
        </Link>
      </div>
    );
  }

  const r = reqs(password);
  const allValid = r.length && r.letter && r.digit;
  const matches = password.length > 0 && password === confirm;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setError(null);

    if (!allValid) {
      setError('הסיסמה לא עומדת בדרישות');
      return;
    }
    if (!matches) {
      setError('הסיסמאות לא תואמות');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data?.error === 'invalid_or_expired_token') {
          setTokenInvalid(true);
          return;
        }
        setError('שגיאה בעדכון הסיסמה. נסי שוב.');
        return;
      }
      toast.success('הסיסמה עודכנה');
      router.push('/login');
    } catch {
      setError('שגיאה זמנית. נסי שוב בעוד רגע.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
      <div>
        <h1 className="text-2xl font-extrabold">בחירת סיסמה חדשה</h1>
        <p className="mt-1 text-sm text-muted-foreground">הזיני סיסמה חדשה לחשבון.</p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <PasswordInput
        id="password"
        label="סיסמה חדשה"
        value={password}
        onChange={setPassword}
        show={show1}
        toggleShow={() => setShow1((v) => !v)}
      />
      <PasswordInput
        id="confirm"
        label="אישור סיסמה"
        value={confirm}
        onChange={setConfirm}
        show={show2}
        toggleShow={() => setShow2((v) => !v)}
        error={confirm.length > 0 && !matches ? 'הסיסמאות לא תואמות' : undefined}
      />

      <ul className="text-xs space-y-1">
        <Req ok={r.length}>לפחות 8 תווים</Req>
        <Req ok={r.letter}>אות אחת לפחות</Req>
        <Req ok={r.digit}>ספרה אחת לפחות</Req>
      </ul>

      <Button type="submit" className="w-full" disabled={submitting || !allValid || !matches}>
        {submitting ? 'מעדכן…' : 'עדכני סיסמה'}
      </Button>
    </form>
  );
}

function PasswordInput({
  id,
  label,
  value,
  onChange,
  show,
  toggleShow,
  error,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  show: boolean;
  toggleShow: () => void;
  error?: string;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          name={id}
          type={show ? 'text' : 'password'}
          autoComplete="new-password"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={cn('pe-9', error && 'border-red-400 bg-red-50 focus-visible:ring-red-200')}
          required
          dir="ltr"
        />
        <button
          type="button"
          onClick={toggleShow}
          className="absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          aria-label={show ? 'הסתר סיסמה' : 'הצג סיסמה'}
          tabIndex={-1}
        >
          {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
      {error && (
        <p className="text-[12px] font-semibold text-red-500 text-right">
          ⚠️ {error}
        </p>
      )}
    </div>
  );
}

function Req({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className={`flex items-center gap-2 ${ok ? 'text-emerald-600' : 'text-muted-foreground'}`}>
      {ok ? <Check className="h-3.5 w-3.5" /> : <Circle className="h-3 w-3" />}
      <span>{children}</span>
    </li>
  );
}
