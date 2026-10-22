// Prints a PDF that lives behind an authenticated, same-origin URL, without a
// download and without leaving a tab behind. Desktop: the PDF loads in an
// invisible frame and that frame's print dialog opens (the CSP allows only
// same-origin frames, so the frame points at the URL itself, not a blob:).
// A phone cannot print a PDF from a frame (iOS prints nothing, Android has no
// inline PDF viewer), so there the PDF opens in the browser's own viewer, which
// carries its own print action.

const CLEANUP_MS = 60_000;
// A browser without an inline PDF viewer never fires `load` for the frame — print anyway instead of hanging.
const LOAD_WAIT_MS = 2_500;

function isTouchPhone(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse) and (hover: none)').matches;
}

export type PrintOutcome = 'dialog' | 'viewer';

export async function printPdf(url: string): Promise<PrintOutcome> {
  if (isTouchPhone()) {
    if (!window.open(url, '_blank')) throw new Error('popup blocked');
    return 'viewer';
  }

  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.style.cssText = 'position:fixed;inset-inline-end:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  await new Promise<void>((resolve) => {
    frame.onload = () => resolve();
    window.setTimeout(resolve, LOAD_WAIT_MS);
    frame.src = url;
    document.body.appendChild(frame);
  });
  const win = frame.contentWindow;
  if (!win) { frame.remove(); throw new Error('pdf frame has no window'); }
  const cleanup = () => frame.remove();
  win.addEventListener('afterprint', cleanup, { once: true });
  window.setTimeout(cleanup, CLEANUP_MS);
  win.focus();
  win.print();
  return 'dialog';
}
