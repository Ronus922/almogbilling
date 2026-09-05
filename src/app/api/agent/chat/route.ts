import { type NextRequest } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { requireAnyPermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { searchDebtors } from '@/lib/db/debtors';
import { writeAudit } from '@/lib/db/audit';
import {
  SEARCH_TOOL,
  SYSTEM_PROMPT,
  mapSearchArgs,
  validateMessages,
} from '@/lib/agent/tool';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

// POST /api/agent/chat — read-only collection agent, streamed over SSE.
// Same RBAC gate as the debtors screen (dashboard:view OR contacts:view). The
// single tool (search_debtors) is just another consumer of searchDebtors — no new
// SQL, no mutations. The agent loop is capped at MAX_ITERATIONS as a safety net.

const MODEL = 'claude-sonnet-4-6';
const MAX_ITERATIONS = 5;
const MAX_TOKENS = 1500;
const RATE_LIMIT = 20; // requests
const RATE_WINDOW_MS = 60_000; // per user, per minute

// ponytail: per-process in-memory limiter; the app runs as a single standalone
// node process, so this is enough. Move to a shared store only if it ever scales
// horizontally.
const hits = new Map<string, number[]>();
function rateLimited(userId: string): boolean {
  const now = Date.now();
  const recent = (hits.get(userId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(userId, recent);
  return recent.length > RATE_LIMIT;
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** Execute the one tool. Read-only: delegates to the existing searchDebtors,
 *  which scans ALL statuses (no tab bucket) and includes archived rows. */
async function runSearchDebtors(input: unknown) {
  const { q, status, limit } = mapSearchArgs(input);
  const rows = await searchDebtors(q, { limit, status });
  return {
    returned: rows.length,
    status_filter: status ?? null,
    debtors: rows.map((d) => ({
      apartment: d.apartment_number,
      owner: d.owner_name,
      tenant: d.tenant_name,
      management_fee: d.management_fees,
      water: d.hot_water_debt,
      total_debt: d.total_debt,
      monthly_debt: d.monthly_debt,
      legal_status: d.legal_status_name,
      is_archived: d.is_archived,
    })),
  };
}

export async function POST(req: NextRequest) {
  let actorId: string;
  try {
    const actor = await requireAnyPermission([
      { module: 'dashboard', action: 'view' },
      { module: 'contacts', action: 'view' },
    ]);
    actorId = actor.id;
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json({ error: 'agent_not_configured' }, 503);

  if (rateLimited(actorId)) return json({ error: 'rate_limited' }, 429);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  const clientMessages = validateMessages((body as { messages?: unknown })?.messages);
  if (!clientMessages) return json({ error: 'invalid_messages' }, 400);

  // Audit: one row per query (fail-safe, never throws). Question = last user turn.
  const lastUser = [...clientMessages].reverse().find((m) => m.role === 'user');
  void writeAudit({
    actorUserId: actorId,
    action: 'agent_query',
    entityType: 'agent_chat',
    metadata: { question: (lastUser?.content ?? '').slice(0, 2000) },
  });

  const anthropic = new Anthropic({ apiKey });
  // Data-only history from the client. Tool instructions live ONLY in SYSTEM_PROMPT;
  // user text is never concatenated into the system prompt (injection guard).
  const messages: Anthropic.MessageParam[] = clientMessages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  let aborted = false;
  req.signal.addEventListener('abort', () => {
    aborted = true;
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const write = (s: string) => {
        if (closed || aborted) return;
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          closed = true;
        }
      };
      const sse = (event: string, data: unknown) =>
        write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      write(': connected\n\n');

      try {
        for (let i = 0; i < MAX_ITERATIONS; i++) {
          if (aborted) break;

          const ms = anthropic.messages.stream(
            {
              model: MODEL,
              max_tokens: MAX_TOKENS,
              system: SYSTEM_PROMPT,
              tools: [SEARCH_TOOL as Anthropic.Tool],
              messages,
            },
            { signal: req.signal },
          );
          ms.on('text', (delta) => sse('text', { delta }));
          const final = await ms.finalMessage();

          const toolUses = final.content.filter(
            (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
          );
          if (final.stop_reason !== 'tool_use' || toolUses.length === 0) break;

          // Live status so the UI shows what's happening while the tool runs.
          // Constant server-side string, lightly varied by tool name.
          sse('status', {
            text: toolUses.some((t) => t.name === 'search_debtors')
              ? 'מחפש עבורך במערכת…'
              : 'עובד על זה…',
          });

          messages.push({ role: 'assistant', content: final.content });
          const results: Anthropic.ToolResultBlockParam[] = [];
          for (const tu of toolUses) {
            let out: unknown;
            try {
              out =
                tu.name === 'search_debtors'
                  ? await runSearchDebtors(tu.input)
                  : { error: 'unknown_tool' };
            } catch (e) {
              logger.error('[agent/chat] tool failed', e);
              out = { error: 'tool_failed' };
            }
            results.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: JSON.stringify(out),
            });
          }
          messages.push({ role: 'user', content: results });

          if (i === MAX_ITERATIONS - 1) {
            sse('text', { delta: '\n\n(הגעתי למגבלת הצעדים — נסה לצמצם את השאלה.)' });
          }
        }
        sse('done', {});
      } catch (err) {
        if (!aborted) {
          logger.error('[agent/chat] stream error', err);
          sse('error', { message: 'שגיאה בעיבוד הבקשה' });
        }
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
