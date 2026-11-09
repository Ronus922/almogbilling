// The file name of a downloaded document photo: {last name}_{first name}_{YYYY-MM-DD}.jpg
// (the date is the day of the scan, Israel time). The names are the visitor's own, typed or read
// from a passport, so they can hold anything: this turns them into a name that is legal on Windows,
// macOS, Android and iOS and safe in a Content-Disposition header. Pure on purpose (no server-only,
// no DB): the route feeds it the row, the tests feed it the worst names we could think of.

/** What no operating system allows in a file name. */
const ILLEGAL = /[\\/:*?"<>|]/g;
/** Control characters and the invisible bidi / zero-width marks a pasted Hebrew-English name drags along. */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;

/** At most this many characters of each name: far above any real name, far below a header's limit. */
const MAX_PART = 60;

/** One name made safe: whitespace runs become one space, invisible characters go, illegal ones become
 *  `_`, and a leading / trailing dot or space (hidden file; Windows strips them) is trimmed. */
export function cleanNamePart(raw: string | null | undefined): string {
  return (raw ?? '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .replace(INVISIBLE, '')
    .replace(ILLEGAL, '_')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, MAX_PART)
    .replace(/[. ]+$/g, '');
}

export interface VisitorDownloadNameInput {
  lastName: string | null | undefined;
  firstName: string | null | undefined;
  /** `YYYY-MM-DD` — the day of the scan. Anything else is left out of the name. */
  scanDate: string | null | undefined;
  /** The stored object's key: its extension is the file's (`.jpg`; `.webp` only before the conversion script ran). */
  objectKey: string;
}

export function visitorDownloadName({ lastName, firstName, scanDate, objectKey }: VisitorDownloadNameInput): string {
  const ext = /\.webp$/i.test(objectKey) ? 'webp' : 'jpg';
  const date = scanDate && /^\d{4}-\d{2}-\d{2}$/.test(scanDate) ? scanDate : '';
  const parts = [cleanNamePart(lastName), cleanNamePart(firstName), date].filter((p) => p !== '');
  return `${parts.length > 0 ? parts.join('_') : 'scan'}.${ext}`;
}
