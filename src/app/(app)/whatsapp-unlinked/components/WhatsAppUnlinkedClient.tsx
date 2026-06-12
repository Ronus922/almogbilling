'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Inbox, Link2, Paperclip, Image as ImageIcon, ExternalLink } from 'lucide-react';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { formatPhoneDisplay } from '@/lib/phone';
import { LinkDebtorDialog } from './LinkDebtorDialog';
import type { UnlinkedMessage } from '@/types/whatsapp';

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('he-IL', {
    timeZone: 'Asia/Jerusalem',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function MessageContent({ m }: { m: UnlinkedMessage }) {
  if ((m.message_type === 'image' || m.message_type === 'document') && m.content) {
    const Icon = m.message_type === 'image' ? ImageIcon : Paperclip;
    return (
      <a
        href={m.content}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-700 hover:underline"
      >
        <Icon className="h-4 w-4 shrink-0" />
        {m.message_type === 'image' ? 'תמונה' : 'קובץ מצורף'}
        <ExternalLink className="h-3 w-3 opacity-70" />
      </a>
    );
  }
  return (
    <span className="line-clamp-2 break-words text-sm text-slate-700">
      {m.content ?? '—'}
    </span>
  );
}

export function WhatsAppUnlinkedClient({ canLink }: { canLink: boolean }) {
  const [messages, setMessages] = useState<UnlinkedMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [linkTarget, setLinkTarget] = useState<UnlinkedMessage | null>(null);

  async function refetch() {
    try {
      const r = await fetch('/api/whatsapp/unlinked', { credentials: 'include' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setMessages((await r.json()) as UnlinkedMessage[]);
    } catch (err) {
      toast.error(`טעינת ההודעות נכשלה: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refetch(); }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold text-slate-900">הודעות לא משויכות</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          הודעות WhatsApp נכנסות שלא זוהה עבורן חייב לפי מספר הטלפון. שייך כל הודעה לחייב המתאים.
        </p>
      </div>

      {loading ? (
        <div className="space-y-2">
          <div className="h-12 rounded-lg bg-slate-100 animate-pulse" />
          <div className="h-12 rounded-lg bg-slate-100 animate-pulse" />
        </div>
      ) : messages.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
          <Table>
            <TableHeader className="[&_tr]:border-b [&_tr]:border-slate-200">
              <TableRow className="bg-slate-50 hover:bg-slate-50">
                <TableHead className="h-11 px-4 text-right text-sm font-semibold text-slate-500">טלפון</TableHead>
                <TableHead className="h-11 px-4 text-right text-sm font-semibold text-slate-500">תוכן</TableHead>
                <TableHead className="h-11 px-4 text-center text-sm font-semibold text-slate-500">התקבל</TableHead>
                {canLink && (
                  <TableHead className="h-11 px-4 text-left text-sm font-semibold text-slate-500">פעולות</TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {messages.map((m) => (
                <TableRow key={m.id} className="border-b border-slate-100 hover:bg-slate-50 h-12">
                  <TableCell className="px-4 py-3 text-right text-sm font-bold text-slate-900 tabular-nums" dir="ltr">
                    {formatPhoneDisplay(m.contact_phone) ?? m.contact_phone}
                  </TableCell>
                  <TableCell className="px-4 py-3 text-right max-w-md">
                    <MessageContent m={m} />
                  </TableCell>
                  <TableCell className="px-4 py-3 text-center text-sm text-slate-500 tabular-nums" dir="ltr">
                    {formatTime(m.created_at)}
                  </TableCell>
                  {canLink && (
                    <TableCell className="px-4 py-3 text-left">
                      <div dir="ltr" className="flex justify-start">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => setLinkTarget(m)}
                          className="gap-1.5"
                        >
                          <Link2 className="h-4 w-4" />
                          שייך לחייב
                        </Button>
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <LinkDebtorDialog
        message={linkTarget}
        onOpenChange={(o) => { if (!o) setLinkTarget(null); }}
        onLinked={async () => { setLinkTarget(null); await refetch(); }}
      />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-slate-200 bg-white p-12 text-center">
      <span className="grid h-14 w-14 place-items-center rounded-full bg-sky-50 text-sky-600">
        <Inbox className="h-6 w-6" />
      </span>
      <h3 className="text-base font-semibold text-slate-900">אין הודעות לא משויכות</h3>
      <p className="text-sm text-muted-foreground">כל ההודעות הנכנסות שויכו לחייבים.</p>
    </div>
  );
}
