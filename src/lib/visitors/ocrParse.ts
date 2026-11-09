import { isRealPastDate } from '@/lib/validation/visitors';
import {
  EMPTY_OCR_FIELDS,
  OCR_FIELDS,
  isDocumentType,
  type OcrField,
  type OcrFields,
} from './model';

// The pure half of the OCR: turn whatever text the model sent back into the
// shape the form takes. No I/O, no env, no 'server-only' — so the unit tests
// run it on hostile and sloppy inputs without touching the network.

export interface ParsedOcr {
  fields: OcrFields;
  confidence: Partial<Record<OcrField, number>>;
}

/** The first top-level JSON object in `text`, tolerating ```json fences and prose around it. */
export function extractJsonObject(text: string): unknown {
  const unfenced = text.replace(/```(?:json)?/gi, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    return null;
  }
}

const clean = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** `YYYY-MM-DD`, also from `DD/MM/YYYY` / `DD.MM.YYYY` / `DD-MM-YYYY`; '' when not a real past date. */
export function normalizeDate(v: unknown): string {
  const raw = clean(v, 20);
  if (raw === '') return '';
  let iso = raw;
  const dmy = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(raw);
  if (dmy) iso = `${dmy[3]}-${dmy[2]!.padStart(2, '0')}-${dmy[1]!.padStart(2, '0')}`;
  return isRealPastDate(iso) ? iso : '';
}

/** A document number has no inner spaces (the card prints them in groups); letters are upper-cased. */
function normalizeNumber(v: unknown): string {
  return clean(v, 60).replace(/[\s]+/g, '').toUpperCase().slice(0, 40);
}

/** 0–1. A model that answers on a 0–100 scale is read as a percentage. */
function normalizeConfidence(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined;
  if (v <= 1) return v;
  return v <= 100 ? v / 100 : undefined;
}

export function parseOcrText(text: string): ParsedOcr | null {
  const obj = extractJsonObject(text);
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;

  const fields: OcrFields = {
    ...EMPTY_OCR_FIELDS,
    document_type: isDocumentType(o.document_type) ? o.document_type : '',
    document_number: normalizeNumber(o.document_number),
    first_name: clean(o.first_name, 80),
    last_name: clean(o.last_name, 80),
    date_of_birth: normalizeDate(o.date_of_birth),
    nationality: clean(o.nationality, 60),
  };

  const confidence: Partial<Record<OcrField, number>> = {};
  const raw = o.confidence !== null && typeof o.confidence === 'object' ? (o.confidence as Record<string, unknown>) : {};
  for (const key of OCR_FIELDS) {
    const c = normalizeConfidence(raw[key]);
    // A confidence for a field the model left empty says nothing; a field with a
    // value but no confidence stays unmarked (the model is not asked to guess one).
    if (c !== undefined && fields[key] !== '') confidence[key] = c;
  }
  return { fields, confidence };
}
