'use client';

import { useEffect, useState } from 'react';
import { jerusalemToday } from '@/lib/issues/board';

/**
 * Today on the Asia/Jerusalem calendar ('YYYY-MM-DD'), re-checked every minute
 * and whenever the tab comes back into view — so a board left open overnight
 * moves its cards into "לטיפול היום" by itself at midnight, with no reload.
 */
export function useJerusalemToday(): string {
  const [today, setToday] = useState(() => jerusalemToday());
  useEffect(() => {
    const tick = () => setToday((cur) => {
      const next = jerusalemToday();
      return next === cur ? cur : next;
    });
    const id = window.setInterval(tick, 60_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);
  return today;
}
