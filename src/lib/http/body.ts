import { NextResponse } from 'next/server';
import type { ZodType } from 'zod';

export type ParsedBody<T> = { ok: true; data: T } | { ok: false; response: NextResponse };

/**
 * The one way a route handler reads its JSON body: `schema.safeParse`, and on
 * failure a 400 carrying `issues` (zod's) plus `error` = the first issue's
 * message, so existing UIs that display `error` keep their Hebrew text.
 * Malformed JSON is 400 `invalid_json`.
 *
 *   const body = await parseJsonBody(req, smtpSettingsBodySchema);
 *   if (!body.ok) return body.response;
 *   body.data // typed
 */
export async function parseJsonBody<T>(req: Request, schema: ZodType<T>): Promise<ParsedBody<T>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { ok: false, response: NextResponse.json({ error: 'invalid_json' }, { status: 400 }) };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues;
    return {
      ok: false,
      response: NextResponse.json({ error: issues[0]?.message ?? 'invalid_body', issues }, { status: 400 }),
    };
  }
  return { ok: true, data: parsed.data };
}
