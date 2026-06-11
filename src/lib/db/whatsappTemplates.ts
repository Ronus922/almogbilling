import 'server-only';
import { query, queryOne } from '@/lib/db';
import type { WhatsAppTemplate } from '@/types/whatsapp';

const SELECT_COLUMNS = `
  id, name, content, is_active, created_by,
  created_at, updated_at
`;

/** Active templates only — used by the send composer. */
export async function listActiveTemplates(): Promise<WhatsAppTemplate[]> {
  const r = await query<WhatsAppTemplate>(
    `select ${SELECT_COLUMNS}
       from public.whatsapp_templates
      where is_active = true
      order by name asc`,
  );
  return r.rows;
}

/** All templates (active + inactive) — used by the management screen. */
export async function listAllTemplates(): Promise<WhatsAppTemplate[]> {
  const r = await query<WhatsAppTemplate>(
    `select ${SELECT_COLUMNS}
       from public.whatsapp_templates
      order by is_active desc, name asc`,
  );
  return r.rows;
}

export async function getTemplateById(id: string): Promise<WhatsAppTemplate | null> {
  return queryOne<WhatsAppTemplate>(
    `select ${SELECT_COLUMNS} from public.whatsapp_templates where id = $1`,
    [id],
  );
}

export async function createTemplate(
  input: { name: string; content: string; is_active: boolean },
  createdBy: string,
): Promise<WhatsAppTemplate> {
  const row = await queryOne<WhatsAppTemplate>(
    `insert into public.whatsapp_templates (name, content, is_active, created_by)
     values ($1, $2, $3, $4)
     returning ${SELECT_COLUMNS}`,
    [input.name, input.content, input.is_active, createdBy],
  );
  // insert ... returning always yields a row.
  return row as WhatsAppTemplate;
}

export async function updateTemplate(
  id: string,
  patch: { name?: string; content?: string; is_active?: boolean },
): Promise<WhatsAppTemplate | null> {
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const key of ['name', 'content', 'is_active'] as const) {
    const v = patch[key];
    if (v === undefined) continue;
    args.push(v);
    sets.push(`${key} = $${args.length}`);
  }
  if (sets.length === 0) return getTemplateById(id);
  args.push(id);
  return queryOne<WhatsAppTemplate>(
    `update public.whatsapp_templates
        set ${sets.join(', ')}
      where id = $${args.length}
      returning ${SELECT_COLUMNS}`,
    args,
  );
}

/** Soft delete — flips is_active to false, never removes the row. */
export async function softDeleteTemplate(id: string): Promise<boolean> {
  const r = await query(
    `update public.whatsapp_templates set is_active = false where id = $1`,
    [id],
  );
  return (r.rowCount ?? 0) > 0;
}
