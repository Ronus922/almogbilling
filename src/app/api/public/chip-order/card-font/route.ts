import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/public/chip-order/card-font — the font of the digits inside the
// card fields of /chip-order (Inter, latin subset — the same file the page's
// own .cr-num inputs use).
//
// WHY A ROUTE: the card number, expiry and CVV are typed inside frames of the
// card processor, another origin. A page there may load a font from here only
// when the answer carries Access-Control-Allow-Origin, and the build's own font
// files (/_next/static/media) carry none. The component hands the frames an
// @font-face that names this URL (PayPlusCardFields.tsx, hostedFieldsCss).
//
// PUBLIC BY DESIGN: one static font file under the SIL Open Font License
// (src/fonts/inter/OFL.txt). No input is read, no data is returned.

// A literal path under process.cwd(), so the build traces the file into the
// standalone output (next.config.ts lists it as well).
const FILE = path.join(process.cwd(), 'src/fonts/inter/inter-latin-wght-normal.woff2');

let font: Promise<Buffer> | null = null;

export async function GET() {
  try {
    font ??= readFile(FILE);
    const bytes = await font;
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': 'font/woff2',
        'Content-Length': String(bytes.byteLength),
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Cache-Control': 'public, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    font = null;
    return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
}
