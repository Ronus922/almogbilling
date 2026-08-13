'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Mail, ShieldCheck, ArrowLeft } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';

export function ForgotPasswordForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function validEmail(e: string) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setError(null);

    if (!validEmail(email.trim())) {
      setError('כתובת אימייל לא תקינה');
      return;
    }

    setSubmitting(true);
    try {
      await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      router.push(`/forgot-password/sent?email=${encodeURIComponent(email.trim())}`);
    } catch {
      setError('שגיאה זמנית. נסה שוב בעוד רגע.');
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
      <div>
        <h1 className="text-2xl font-extrabold">שחזור סיסמה</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          הזיני את כתובת האימייל שלך ונשלח לך קישור לאיפוס.
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-2">
        <Label htmlFor="email">אימייל</Label>
        <div className="relative">
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="pe-9"
            required
            dir="ltr"
          />
          <Mail className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        </div>
      </div>

      <Button type="submit" className="w-full" disabled={submitting}>
        {submitting ? 'שולח…' : 'שלחי קישור איפוס'}
      </Button>

      <Link
        href="/login"
        className="inline-flex h-11 items-center gap-1.5 text-sm roomy:h-auto text-primary hover:underline self-start"
      >
        <ArrowLeft className="h-4 w-4" />
        חזרה להתחברות
      </Link>

      <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground flex gap-2">
        <ShieldCheck className="h-4 w-4 shrink-0 mt-0.5 text-primary" />
        <div>
          <div className="font-medium text-foreground">אבטחת חשבון</div>
          <div className="mt-0.5">
            מסיבות אבטחה, המערכת מחזירה תשובה זהה גם אם כתובת האימייל לא רשומה במערכת.
          </div>
        </div>
      </div>
    </form>
  );
}
