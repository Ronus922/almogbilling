import type { PoolClient } from 'pg';

// ─────────────────────── event types ───────────────────────

export type DebtorEventType =
  | 'PHONE_CALL'
  | 'SMS'
  | 'WHATSAPP'
  | 'EMAIL'
  | 'MEETING'
  | 'ARCHIVE'
  | 'UNARCHIVE'
  | 'WARNING_LETTER'
  | 'LEGAL_PROCEEDING'
  | 'SYSTEM'
  | 'OTHER';

// Manual documentation channels — the only types a user may create via
// POST /api/debtors/[id]/events. The rest are written automatically by the
// system (archive/unarchive/...).
export const MANUAL_EVENT_TYPES: readonly DebtorEventType[] = [
  'PHONE_CALL', 'SMS', 'WHATSAPP', 'EMAIL', 'MEETING', 'OTHER',
] as const;

// System-generated event types — used by the timeline's "מערכת" filter.
export const SYSTEM_EVENT_TYPES: readonly DebtorEventType[] = [
  'ARCHIVE', 'UNARCHIVE', 'SYSTEM',
] as const;

export function isManualEventType(v: unknown): v is DebtorEventType {
  return typeof v === 'string' && (MANUAL_EVENT_TYPES as readonly string[]).includes(v);
}

// ─────────────────── Hebrew display map ────────────────────
// Client-safe: `icon` is the *name* of a lucide-react icon (resolved to a
// component by the timeline), `tone` keys into the timeline's colour map.

export interface EventTypeMeta {
  label: string;
  icon: string;
  tone: string;
}

export const EVENT_TYPE_META: Record<DebtorEventType, EventTypeMeta> = {
  PHONE_CALL:       { label: 'שיחת טלפון',  icon: 'Phone',             tone: 'blue'    },
  SMS:              { label: 'הודעת SMS',   icon: 'MessageSquareText', tone: 'cyan'    },
  WHATSAPP:         { label: 'וואטסאפ',     icon: 'MessageCircle',     tone: 'emerald' },
  EMAIL:            { label: 'אימייל',       icon: 'Mail',              tone: 'violet'  },
  MEETING:          { label: 'פגישה',        icon: 'Users',             tone: 'amber'   },
  ARCHIVE:          { label: 'הועבר לארכיון', icon: 'Archive',          tone: 'slate'   },
  UNARCHIVE:        { label: 'שוחזר מארכיון', icon: 'ArchiveRestore',   tone: 'slate'   },
  WARNING_LETTER:   { label: 'מכתב התראה',   icon: 'FileWarning',       tone: 'amber'   },
  LEGAL_PROCEEDING: { label: 'הליך משפטי',   icon: 'Scale',             tone: 'red'     },
  SYSTEM:           { label: 'מערכת',         icon: 'Settings2',         tone: 'slate'   },
  OTHER:            { label: 'אחר',           icon: 'StickyNote',        tone: 'slate'   },
};

// ─────────────────────── logging ───────────────────────────

export interface EventActor {
  id: string | null;
  name: string | null;
  email: string | null;
}

export interface LogDebtorEventArgs {
  debtorId: string;
  eventType: DebtorEventType;
  title: string;
  description?: string | null;
  outcome?: string | null;
  metadata?: Record<string, unknown>;
  actor: EventActor;
}

/**
 * Insert a debtor_events row. Takes a pg client so it can run inside an existing
 * transaction (archive flow, manual documentation, ...). No `server-only` import
 * here so the display map above stays importable from client components — the
 * `PoolClient` type is erased at compile time.
 */
export async function logDebtorEvent(
  client: PoolClient,
  args: LogDebtorEventArgs,
): Promise<void> {
  await client.query(
    `insert into public.debtor_events
       (debtor_id, event_type, title, description, outcome, metadata,
        actor_id, actor_name, actor_email)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
    [
      args.debtorId,
      args.eventType,
      args.title,
      args.description ?? null,
      args.outcome ?? null,
      JSON.stringify(args.metadata ?? {}),
      args.actor.id,
      args.actor.name,
      args.actor.email,
    ],
  );
}
