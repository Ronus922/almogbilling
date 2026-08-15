'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Check, EllipsisVertical, Share, SquarePlus, X, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';

/**
 * Global mobile PWA install promotion. Mounted once in the root layout (next to
 * the Toaster) so the `beforeinstallprompt` listener is registered as early as
 * possible — the event often fires on /login before any (app) layout mounts.
 *
 * Renders null on the server and on desktop; on eligible phones it shows a
 * bottom banner once per session. The native browser prompt is only ever
 * triggered from the banner's CTA (Chromium); iOS and browsers without the
 * event get a short "add to Home Screen" instruction sheet instead.
 */

// Chromium's install event — not part of lib.dom.
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

const DISMISSED_AT_KEY = 'almog:pwa-install:dismissed-at';
const INSTALLED_KEY = 'almog:pwa-install:installed';
const SESSION_SHOWN_KEY = 'almog:pwa-install:shown';
const DISMISS_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // שבוע שקט אחרי סגירה
const SHOW_DELAY_MS = 2600; // אחרי hydration והטעינה הראשונית

// Storage helpers — Safari private mode may throw on any access; the banner
// simply behaves as "fresh visitor" when storage is unavailable.
function readStorage(kind: 'local' | 'session', key: string): string | null {
  try {
    return (kind === 'local' ? window.localStorage : window.sessionStorage).getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(kind: 'local' | 'session', key: string, value: string): void {
  try {
    (kind === 'local' ? window.localStorage : window.sessionStorage).setItem(key, value);
  } catch {
    // אחסון חסום — מוותרים בשקט
  }
}

function isStandaloneDisplay(): boolean {
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return window.matchMedia('(display-mode: standalone)').matches || nav.standalone === true;
}

// Phone = coarse pointer AND (narrow portrait OR short landscape) — the same
// boundary responsive.css uses. Coarse-pointer keeps narrow desktop windows out.
function isPhoneViewport(): boolean {
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const narrow = window.matchMedia('(max-width: 767.98px)').matches;
  const shortLandscape = window.matchMedia('(max-height: 480px)').matches;
  return coarse && (narrow || shortLandscape);
}

function isIOSDevice(): boolean {
  const ua = window.navigator.userAgent;
  // iPadOS 13+ reports itself as Macintosh; the touch-points check separates it.
  const iPadOS = /Macintosh/.test(ua) && window.navigator.maxTouchPoints > 1;
  return /iPhone|iPad|iPod/.test(ua) || iPadOS;
}

interface GuideStep {
  icon: LucideIcon;
  text: string;
}

const IOS_STEPS: GuideStep[] = [
  { icon: Share, text: 'פתחו את תפריט השיתוף בדפדפן' },
  { icon: SquarePlus, text: 'בחרו "הוספה למסך הבית"' },
  { icon: Check, text: 'אשרו בלחיצה על "הוסף"' },
];

const MENU_STEPS: GuideStep[] = [
  { icon: EllipsisVertical, text: 'פתחו את תפריט הדפדפן' },
  { icon: SquarePlus, text: 'בחרו "הוספה למסך הבית" או "התקנת אפליקציה"' },
  { icon: Check, text: 'אשרו את ההוספה' },
];

export function InstallPrompt() {
  const pathname = usePathname();
  const [visible, setVisible] = useState(false);
  const [guide, setGuide] = useState<'ios' | 'menu' | null>(null);
  const deferredRef = useRef<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const onBeforeInstallPrompt = (event: Event) => {
      // Suppress Chrome's mini-infobar; installation runs from our CTA only.
      event.preventDefault();
      deferredRef.current = event as BeforeInstallPromptEvent;
    };
    const onAppInstalled = () => {
      deferredRef.current = null;
      writeStorage('local', INSTALLED_KEY, '1');
      setVisible(false);
      setGuide(null);
      toast.success('ניהול אלמוג הותקן בהצלחה');
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onAppInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onAppInstalled);
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!isPhoneViewport()) return;
      if (isStandaloneDisplay()) return;
      if (readStorage('local', INSTALLED_KEY) === '1') return;
      if (readStorage('session', SESSION_SHOWN_KEY) === '1') return;
      const dismissedAt = Number(readStorage('local', DISMISSED_AT_KEY) ?? '0');
      if (dismissedAt > 0 && Date.now() - dismissedAt < DISMISS_COOLDOWN_MS) return;
      writeStorage('session', SESSION_SHOWN_KEY, '1');
      setVisible(true);
    }, SHOW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);

  const dismiss = useCallback(() => {
    writeStorage('local', DISMISSED_AT_KEY, String(Date.now()));
    setVisible(false);
    setGuide(null);
  }, []);

  const install = useCallback(async () => {
    const deferred = deferredRef.current;
    if (deferred) {
      // Chromium allows prompt() once per event — consume it either way.
      deferredRef.current = null;
      await deferred.prompt();
      const choice = await deferred.userChoice;
      if (choice.outcome === 'accepted') {
        setVisible(false); // appinstalled ישלים: דגל + toast
      } else {
        dismiss();
      }
      return;
    }
    // אין אירוע התקנה (iOS / Firefox וכד') — מדריך קצר במקום כפתור מת.
    setGuide(isIOSDevice() ? 'ios' : 'menu');
  }, [dismiss]);

  // עמוד ההדפסה עומד בפני עצמו — בלי קידום התקנה.
  if (pathname.startsWith('/debtors/') && pathname.endsWith('/print')) return null;
  if (!visible) return null;

  const steps = guide === 'ios' ? IOS_STEPS : MENU_STEPS;

  return (
    <>
      <div
        role="region"
        aria-label="הצעה להתקנת האפליקציה"
        data-install-banner=""
        className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-[0_-4px_16px_rgba(15,23,42,0.08)] animate-in fade-in-0 slide-in-from-bottom-6 ease-[cubic-bezier(0.16,0.84,0.26,1)] duration-500 motion-reduce:animate-none roomy:hidden"
      >
        <div className="flex items-center gap-3">
          <img
            src="/icons/icon-rounded.svg"
            alt=""
            width={44}
            height={44}
            className="h-11 w-11 shrink-0"
          />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-bold text-ink">התקנת ניהול אלמוג</div>
            <div className="truncate text-xs text-ink-2">גישה מהירה מהמסך הראשי, במסך מלא</div>
          </div>
          <Button className="px-4" onClick={() => void install()}>
            התקנה
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="סגירת ההצעה"
            className="hit-44 relative shrink-0"
            onClick={dismiss}
          >
            <X />
          </Button>
        </div>
      </div>

      <Sheet
        open={guide !== null}
        onOpenChange={(open) => {
          if (!open) dismiss();
        }}
      >
        <SheetContent side="bottom" className="rounded-t-2xl bg-white">
          <SheetHeader className="p-6 pb-0">
            <SheetTitle className="text-base font-bold text-ink">הוספה למסך הבית</SheetTitle>
            <SheetDescription className="text-sm text-ink-2">
              שלושה צעדים קצרים, בלי חנות אפליקציות:
            </SheetDescription>
          </SheetHeader>
          <ol className="flex flex-col gap-3 p-6 pt-2 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
            {steps.map((step) => (
              <li key={step.text} className="flex items-center gap-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand-text">
                  <step.icon className="size-5" aria-hidden />
                </span>
                <span className="text-sm text-ink">{step.text}</span>
              </li>
            ))}
          </ol>
        </SheetContent>
      </Sheet>
    </>
  );
}
