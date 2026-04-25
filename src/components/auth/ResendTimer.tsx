'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { RESEND_COOLDOWN_SECONDS } from '@/lib/constants';

export function ResendTimer({ email }: { email: string }) {
  const [remaining, setRemaining] = useState(RESEND_COOLDOWN_SECONDS);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (remaining <= 0) return;
    const id = setInterval(() => setRemaining((v) => (v > 0 ? v - 1 : 0)), 1000);
    return () => clearInterval(id);
  }, [remaining]);

  async function onResend() {
    if (remaining > 0 || sending) return;
    setSending(true);
    try {
      await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      toast.success('קישור חדש נשלח');
      setRemaining(RESEND_COOLDOWN_SECONDS);
    } catch {
      toast.error('שגיאה זמנית. נסו שוב בעוד רגע.');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 items-center">
      <Button
        type="button"
        variant="outline"
        className="w-full"
        disabled={remaining > 0 || sending}
        onClick={onResend}
      >
        {remaining > 0 ? `שלחי שוב (אחרי ${remaining} שניות)` : 'שלחי שוב'}
      </Button>
      <Link href="/forgot-password" className="text-xs text-muted-foreground hover:text-primary hover:underline">
        שגיאה במייל? שני כתובת
      </Link>
    </div>
  );
}
