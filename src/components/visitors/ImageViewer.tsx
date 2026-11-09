'use client';

import { useState } from 'react';
import { X, ZoomIn, ZoomOut } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

// Full-screen view of a document photo: fits the screen, one tap / click zooms
// to the photo's natural size (scrollable), the system pinch-zoom works too
// (touch-action: pinch-zoom), Esc or the X closes. The photo is a same-origin
// /api/files path — the browser sends the session cookie with it.
//
// A Dialog (static info, DESIGN §12), rendered INSIDE the detail sheet's React
// tree so it is a nested dialog of it: a modal sheet makes everything outside
// itself inert, and a plain fixed overlay beside it would be unreachable.

interface Props {
  open: boolean;
  src: string;
  alt: string;
  onClose: () => void;
}

export function ImageViewer({ open, src, alt, onClose }: Props) {
  const [zoomed, setZoomed] = useState(false);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { setZoomed(false); onClose(); } }}>
      <DialogContent
        showCloseButton={false}
        dir="rtl"
        className="top-0 start-0 flex h-dvh max-h-none w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none bg-black p-0 ring-0 sm:max-w-none rtl:translate-x-0"
      >
        <DialogTitle className="sr-only">{alt}</DialogTitle>
        <div className="flex flex-none items-center justify-between gap-3 px-4 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))]">
          <button
            type="button" onClick={() => setZoomed((z) => !z)}
            aria-label={zoomed ? 'התאם למסך' : 'הגדל'}
            className="flex h-11 items-center gap-2 rounded-lg border border-white/25 bg-white/5 px-4 text-sm font-semibold text-white hover:bg-white/15"
          >
            {zoomed ? <ZoomOut className="h-4 w-4" aria-hidden /> : <ZoomIn className="h-4 w-4" aria-hidden />}
            {zoomed ? 'התאם למסך' : 'הגדל'}
          </button>
          <button
            type="button" onClick={() => { setZoomed(false); onClose(); }} aria-label="סגור את התצוגה"
            className="flex h-11 w-11 items-center justify-center rounded-lg border border-white/25 bg-white/5 text-white hover:bg-white/15"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
        <div
          className={cn('min-h-0 flex-1 p-2', zoomed ? 'overflow-auto' : 'overflow-hidden')}
          style={{ touchAction: 'pinch-zoom pan-x pan-y' }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- a private, session-gated proxy path; next/image would fetch it unauthenticated */}
          <img
            src={src} alt={alt} onClick={() => setZoomed((z) => !z)} data-visitor-photo-full
            className={cn(
              'mx-auto select-none',
              zoomed ? 'max-w-none cursor-zoom-out' : 'h-full w-full cursor-zoom-in object-contain',
            )}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
