import { inflateSync } from 'node:zlib';

// Reads a jsPDF file back the way a page is painted: every text-show operator
// with the characters in the order they are DRAWN, left to right, and where
// the line starts. A text extractor (pdftotext, a viewer's copy) re-orders
// right-to-left text on its own, so it cannot tell a mirrored phone number
// from a correct one; the paint order can. Glyph ids are turned back into
// characters through the font's own ToUnicode map — only an EMBEDDED font has
// one in a jsPDF file, so `text: null` means "drawn with a font that is not in
// the file".

export interface Painted {
  page: number;
  /** Where the line starts, in points from the page's left / bottom edge. */
  x: number;
  y: number;
  /** The characters in paint order; null = not an embedded font. */
  text: string | null;
}

interface PdfObject { dict: string; stream: Buffer | null }

function readObjects(pdf: Buffer): Map<number, PdfObject> {
  const raw = pdf.toString('latin1'); // one character per byte
  const out = new Map<number, PdfObject>();
  const head = /(\d+) 0 obj\n/g;
  let m: RegExpExecArray | null;
  while ((m = head.exec(raw))) {
    const start = m.index + m[0].length;
    const streamAt = raw.indexOf('stream\n', start);
    const endAt = raw.indexOf('endobj', start);
    if (streamAt !== -1 && streamAt < endAt) {
      const dict = raw.slice(start, streamAt);
      const length = Number(/\/Length (\d+)/.exec(dict)?.[1] ?? 0);
      const from = streamAt + 'stream\n'.length;
      const data = pdf.subarray(from, from + length);
      out.set(Number(m[1]), { dict, stream: dict.includes('FlateDecode') ? inflateSync(data) : data });
      head.lastIndex = from + length; // never read object headers out of binary data
    } else {
      out.set(Number(m[1]), { dict: raw.slice(start, endAt), stream: null });
    }
  }
  return out;
}

export function paintedText(pdf: Buffer): Painted[] {
  const objects = readObjects(pdf);
  // Resource name (F15) → the font object → its ToUnicode map.
  const maps = new Map<string, Map<number, string>>();
  for (const { dict, stream } of objects.values()) {
    if (stream) continue;
    for (const ref of dict.matchAll(/\/(F\d+) (\d+) 0 R/g)) {
      const cmapRef = /\/ToUnicode (\d+) 0 R/.exec(objects.get(Number(ref[2]))?.dict ?? '');
      const cmap = cmapRef && objects.get(Number(cmapRef[1]))?.stream;
      if (!cmap) continue;
      const map = new Map<number, string>();
      for (const pair of cmap.toString('latin1').matchAll(/<([0-9a-fA-F]{4})><([0-9a-fA-F]{4})>/g)) {
        map.set(parseInt(pair[1]!, 16), String.fromCodePoint(parseInt(pair[2]!, 16)));
      }
      maps.set(ref[1]!, map);
    }
  }

  const out: Painted[] = [];
  let page = 0;
  for (const { stream } of objects.values()) {
    const body = stream?.toString('latin1') ?? '';
    if (!/\bTf\b/.test(body) || !/\bTj\b/.test(body)) continue; // a page's content stream
    page += 1;
    let font = '';
    let x = 0;
    let y = 0;
    for (const line of body.split('\n')) {
      const tf = /^\/(F\d+) [\d.]+ Tf/.exec(line);
      if (tf) { font = tf[1]!; continue; }
      const td = /^(-?[\d.]+) (-?[\d.]+) Td/.exec(line);
      if (td) { x = Number(td[1]); y = Number(td[2]); continue; }
      const tj = /^<([0-9a-fA-F]*)> Tj/.exec(line);
      if (!tj) continue;
      const map = maps.get(font);
      let text: string | null = null;
      if (map) {
        text = '';
        for (let i = 0; i < tj[1]!.length; i += 4) text += map.get(parseInt(tj[1]!.slice(i, i + 4), 16)) ?? '\uFFFD';
      }
      out.push({ page, x, y, text });
    }
  }
  return out;
}
