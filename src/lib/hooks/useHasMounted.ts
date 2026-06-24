import { useEffect, useState } from 'react';

/**
 * Returns false on the server and on the client's first (hydration) render, then
 * true after mount. Use to gate genuinely time-relative output — values derived
 * from `Date.now()` such as "לפני X דקות" or a freshness severity — so SSR and the
 * first client render produce identical markup (no React #418 hydration mismatch).
 * Render a stable, deterministic value while `false`; switch to the relative value
 * once `true`.
 */
export function useHasMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}
