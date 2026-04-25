'use client';

import { Button } from '@/components/ui/button';
import { toast } from 'sonner';

export function GoogleButton() {
  function onClick() {
    toast.info("התחברות עם Google תהיה זמינה בפאזה הבאה");
  }
  return (
    <Button type="button" variant="outline" className="w-full gap-2" onClick={onClick}>
      <GoogleIcon />
      <span>התחבר</span>
    </Button>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden>
      <path
        fill="#EA4335"
        d="M12 10.2v3.96h5.52c-.24 1.44-1.68 4.2-5.52 4.2-3.36 0-6.12-2.76-6.12-6.12S8.64 6.12 12 6.12c1.92 0 3.24.84 3.96 1.56l2.64-2.64C16.92 3.48 14.64 2.4 12 2.4 6.72 2.4 2.4 6.72 2.4 12s4.32 9.6 9.6 9.6c5.52 0 9.24-3.84 9.24-9.36 0-.6-.12-1.2-.24-1.8z"
      />
      <path
        fill="#34A853"
        d="M12 21.6c2.64 0 4.92-.84 6.6-2.4l-3.24-2.52c-.84.6-2.04.96-3.36.96-2.64 0-4.92-1.68-5.76-4.08H2.88v2.52C4.56 19.2 7.92 21.6 12 21.6z"
      />
      <path
        fill="#4A90E2"
        d="M6.24 13.56c-.24-.6-.36-1.2-.36-1.8s.12-1.2.36-1.8V7.44H2.88C2.4 8.76 2.16 10.2 2.16 11.76c0 1.56.24 3 .72 4.32l3.36-2.52z"
      />
      <path
        fill="#FBBC05"
        d="M12 6.12c1.44 0 2.64.48 3.6 1.44l2.76-2.76C16.92 3.48 14.64 2.4 12 2.4 7.92 2.4 4.56 4.8 2.88 8.16l3.36 2.52C7.08 7.8 9.36 6.12 12 6.12z"
      />
    </svg>
  );
}
