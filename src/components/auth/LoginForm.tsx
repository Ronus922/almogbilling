'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { User, Lock, Eye, EyeOff, ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { GoogleButton } from './GoogleButton';

// Map ?reason=… query params to a user-facing toast.
// Extend in the future for session_expired, role_changed, etc.
const REASON_TOASTS: Record<string, string> = {
  disabled: 'החשבון שלך הושבת. פנה למנהל המערכת.',
};

// Map ?error=… query params (Google OAuth callback outcomes) to a toast.
const ERROR_TOASTS: Record<string, string> = {
  google_not_allowed: 'כניסה עם Google לא אושרה לחשבונך. פנה למנהל המערכת.',
  google_failed: 'ההתחברות עם Google נכשלה. נסה שוב.',
  google_unavailable: 'כניסה עם Google אינה זמינה כרגע.',
};

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const reason = searchParams.get('reason');
    const errorCode = searchParams.get('error');
    if (reason && REASON_TOASTS[reason]) {
      toast.error(REASON_TOASTS[reason]);
      router.replace('/login', { scroll: false });
    } else if (errorCode && ERROR_TOASTS[errorCode]) {
      toast.error(ERROR_TOASTS[errorCode]);
      router.replace('/login', { scroll: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setError(null);

    if (!username.trim() || !password) {
      setError('שם משתמש או סיסמה שגויים');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password, remember }),
      });
      if (!res.ok) {
        setError('שם משתמש או סיסמה שגויים');
        return;
      }
      // Hard redirect so the session cookie is picked up on the next request.
      // Land on the root, which role-routes (viewer → /dashboard, else → /overview).
      window.location.href = '/';
    } catch {
      setError('שגיאה זמנית. נסה שוב בעוד רגע.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
      <div>
        <h1 className="text-[26px] font-extrabold tracking-tight text-slate-900">התחברות</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">הזן שם משתמש וסיסמה כדי להיכנס למערכת</p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-2">
        <Label htmlFor="username" className="text-[13px] font-semibold text-slate-700">שם משתמש</Label>
        <div className="relative">
          <Input
            id="username"
            name="username"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="h-12 rounded-xl pe-11"
            required
            dir="ltr"
          />
          <User className="pointer-events-none absolute start-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-slate-400" />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="password" className="text-[13px] font-semibold text-slate-700">סיסמה</Label>
        <div className="relative">
          <Input
            id="password"
            name="password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="h-12 rounded-xl px-11"
            required
            dir="ltr"
          />
          <Lock className="pointer-events-none absolute start-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-slate-400" />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            className="absolute end-2 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-lg text-slate-400 hover:text-slate-600"
            aria-label={showPassword ? 'הסתר סיסמה' : 'הצג סיסמה'}
            tabIndex={-1}
          >
            {showPassword ? <EyeOff className="h-[18px] w-[18px]" /> : <Eye className="h-[18px] w-[18px]" />}
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between text-sm">
        <label className="flex cursor-pointer items-center gap-2">
          <Checkbox
            checked={remember}
            onCheckedChange={(v) => setRemember(v === true)}
            id="remember"
          />
          <span className="text-slate-600">זכור אותי במכשיר זה</span>
        </label>
        <Link href="/forgot-password" className="font-semibold text-blue-600 hover:underline">
          שכחת סיסמה?
        </Link>
      </div>

      <Button
        type="submit"
        size="lg"
        disabled={submitting}
        className="w-full gap-2 bg-gradient-to-l from-blue-700 to-blue-600 text-white shadow-[0_12px_24px_-6px_rgba(37,99,235,0.5)] hover:from-blue-800 hover:to-blue-700"
      >
        {submitting ? (
          'מתחבר…'
        ) : (
          <>
            התחבר
            <ArrowLeft className="h-[18px] w-[18px]" />
          </>
        )}
      </Button>

      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-slate-200" />
        <span className="text-xs text-slate-400">או</span>
        <span className="h-px flex-1 bg-slate-200" />
      </div>

      <GoogleButton />

      <p className="mt-2 text-center text-xs text-slate-400">
        © {new Date().getFullYear()} ALMOG CRM — כל הזכויות שמורות
      </p>
    </form>
  );
}
