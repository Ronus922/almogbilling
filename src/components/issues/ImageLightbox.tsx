'use client';

import { useEffect } from 'react';
import { X } from 'lucide-react';

interface Props {
  open: boolean;
  src: string | null;
  alt?: string;
  onClose: () => void;
}

/**
 * Minimal full-screen image lightbox. Click the backdrop or the X (or press
 * ESC) to close. RTL-agnostic — the image is centered. Rendered above the side
 * panel (z-[60]) so it works while the issue panel is open.
 */
export function ImageLightbox({ open, src, alt, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  if (!open || !src) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="תצוגת תמונה"
      onClick={onClose}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm"
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="סגור תצוגה"
        className="absolute top-4 end-4 grid h-11 w-11 place-items-center rounded-lg border border-white/25 bg-white/10 text-white transition-colors hover:bg-white/20"
      >
        <X className="h-5 w-5" />
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt ?? 'תמונת תקלה'}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain shadow-2xl"
      />
    </div>
  );
}
