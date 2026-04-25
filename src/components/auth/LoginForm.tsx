'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { User, Eye, EyeOff } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import { GoogleButton } from './GoogleButton';

export function LoginForm() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      // Hard redirect so the session cookie is picked up by middleware on the next request.
      window.location.href = '/dashboard';
    } catch {
      setError('שגיאה זמנית. נסה שוב בעוד רגע.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
      <div>
        <h1 className="text-2xl font-extrabold">התחברות למערכת</h1>
        <p className="mt-1 text-sm text-muted-foreground">נא להזין שם משתמש וסיסמה.</p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-2">
        <Label htmlFor="username">שם משתמש</Label>
        <div className="relative">
          <Input
            id="username"
            name="username"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="pe-9"
            required
            dir="ltr"
          />
          <User className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="password">סיסמה</Label>
        <div className="relative">
          <Input
            id="password"
            name="password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="pe-9"
            required
            dir="ltr"
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            className="absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            aria-label={showPassword ? 'הסתר סיסמה' : 'הצג סיסמה'}
            tabIndex={-1}
          >
            {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between text-sm">
        <label className="flex items-center gap-2 cursor-pointer">
          <Checkbox
            checked={remember}
            onCheckedChange={(v) => setRemember(v === true)}
            id="remember"
          />
          <span>זכור אותי במכשיר זה</span>
        </label>
        <Link href="/forgot-password" className="text-primary hover:underline">
          שכחת סיסמה?
        </Link>
      </div>

      <Button type="submit" className="w-full" disabled={submitting}>
        {submitting ? 'מתחבר…' : 'התחבר'}
      </Button>

      <div className="relative">
        <Separator />
        <span className="absolute inset-x-0 -top-2.5 mx-auto w-fit bg-card px-2 text-xs text-muted-foreground">
          או
        </span>
      </div>

      <GoogleButton />

      <p className="text-center text-xs text-muted-foreground">
        בלחיצה על &quot;התחבר&quot; הינך מסכים{' '}
        <Link href="#" className="text-primary hover:underline">
          לתנאי השימוש ולמדיניות הפרטיות
        </Link>
        .
      </p>
    </form>
  );
}
