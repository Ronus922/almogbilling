'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Search, Upload, Download, Plus, RefreshCcwDot } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { residentTypeLabel } from '@/lib/constants/contacts';
import type { Contact } from '@/lib/types/contacts';
import type { ContactSuggestion } from '@/lib/types/contactSuggestions';
import { ContactsTable } from '@/components/contacts/contacts-table';
import { ContactFormPanel } from '@/components/contacts/contact-form-panel';
import { ContactImportPanel } from '@/components/contacts/contact-import-panel';
import { ContactSuggestionsPanel } from '@/components/contacts/contact-suggestions-panel';

/** Registry coverage quick-filter: whole list / no person at all / needs review. */
type QuickFilter = 'all' | 'no_contact' | 'needs_review';

/** True when name AND phone are empty across ALL THREE roles (owner/tenant/operator). */
function hasNoContactPerson(c: Contact): boolean {
  return (
    !c.owner_name?.trim() && !c.owner_phone?.trim() &&
    !c.tenant_name?.trim() && !c.tenant_phone?.trim() &&
    !c.operator_name?.trim() && !c.operator_phone?.trim()
  );
}

export function ContactsPageClient({
  initialContacts,
  canEdit,
  canViewParking,
  canEditParking,
  pendingSuggestions,
}: {
  initialContacts: Contact[];
  canEdit: boolean;
  canViewParking: boolean;
  canEditParking: boolean;
  /** Open Bllink proposals. Zero hides the button entirely. */
  pendingSuggestions: number;
}) {
  const [contacts, setContacts] = useState<Contact[]>(initialContacts);
  const [search, setSearch] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [quickFilter, setQuickFilter] = useState<QuickFilter>('all');
  const [loading, setLoading] = useState(false);

  const [showImport, setShowImport] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestionCount, setSuggestionCount] = useState(pendingSuggestions);
  // null = the queue is being fetched. Loaded on the click that opens the
  // panel, never with the page: the queue is usually empty and its button is
  // not even drawn then.
  const [suggestions, setSuggestions] = useState<ContactSuggestion[] | null>(null);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Deep link: ?apt=X opens that apartment's card (the "השלם שם" link of
  // /admin/portal-blocked) — as the INITIAL state, so nothing re-renders for
  // it. The param is stripped right after, so a refresh does not reopen it.
  const [deepLinked] = useState<Contact | null>(
    () => initialContacts.find((x) => x.apartment_number === searchParams.get('apt')) ?? null,
  );
  const [formOpen, setFormOpen] = useState(deepLinked !== null);
  const [editingContact, setEditingContact] = useState<Contact | null>(deepLinked);

  const didMount = useRef(false);

  useEffect(() => {
    if (!searchParams.get('apt')) return;
    const next = new URLSearchParams(searchParams.toString());
    next.delete('apt');
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
    // run-once on mount; later changes are the user's own navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchContacts = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('search', search.trim());
      if (selectedTags.length) params.set('tags', selectedTags.join(','));
      const qs = params.toString();
      const res = await fetch(qs ? `/api/contacts?${qs}` : '/api/contacts', { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { items?: Contact[] };
      setContacts(Array.isArray(data.items) ? data.items : []);
    } catch (err) {
      toast.error(`טעינת הדיירים נכשלה: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [search, selectedTags]);

  // Initial data comes from the server; refetch only when filters change.
  useEffect(() => {
    if (!didMount.current) { didMount.current = true; return; }
    const t = setTimeout(() => { void fetchContacts(); }, 300);
    return () => clearTimeout(t);
  }, [fetchContacts]);

  const allTags = useMemo(
    () => Array.from(new Set([...contacts.flatMap((c) => c.tags), ...selectedTags])).sort((a, b) => a.localeCompare(b, 'he')),
    [contacts, selectedTags],
  );

  // Coverage summary over the loaded (server-filtered) set; the quick filter
  // itself narrows client-side so the numbers stay visible while filtering.
  const summary = useMemo(
    () => ({
      total: contacts.length,
      noContact: contacts.filter(hasNoContactPerson).length,
      needsReview: contacts.filter((c) => c.needs_review).length,
    }),
    [contacts],
  );

  const visibleContacts = useMemo(() => {
    if (quickFilter === 'no_contact') return contacts.filter(hasNoContactPerson);
    if (quickFilter === 'needs_review') return contacts.filter((c) => c.needs_review);
    return contacts;
  }, [contacts, quickFilter]);

  function toggleTag(tag: string) {
    setSelectedTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  }

  async function openSuggestions() {
    setShowSuggestions(true);
    setSuggestions(null);
    try {
      const res = await fetch('/api/contacts/suggestions', { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { items?: ContactSuggestion[] };
      const items = Array.isArray(data.items) ? data.items : [];
      setSuggestions(items);
      setSuggestionCount(items.length);
    } catch (err) {
      setSuggestions([]);
      toast.error(`טעינת ההצעות נכשלה: ${(err as Error).message}`);
    }
  }

  function openCreate() {
    setEditingContact(null);
    setFormOpen(true);
  }
  function openEdit(id: string) {
    const c = contacts.find((x) => x.id === id) ?? null;
    setEditingContact(c);
    setFormOpen(true);
  }

  function exportCsv() {
    if (contacts.length === 0) { toast.info('אין נתונים לייצוא'); return; }
    const headers = ['דירה', 'שם בעלים', 'טלפון בעלים', 'אימייל בעלים', 'שם שוכר', 'טלפון שוכר', 'אימייל שוכר', 'סוג דייר'];
    const esc = (v: string | null) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [headers.join(',')];
    for (const c of contacts) {
      lines.push([
        c.apartment_number, c.owner_name, c.owner_phone, c.owner_email,
        c.tenant_name, c.tenant_phone, c.tenant_email, residentTypeLabel(c.resident_type),
      ].map(esc).join(','));
    }
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `contacts_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-extrabold text-slate-900">רשימת דיירים</h1>
          <span className="text-sm text-muted-foreground tabular-nums">{contacts.length} דירות במערכת</span>
        </div>

        <div className="flex items-center gap-2">
          {/* The Bllink queue. Only drawn when something is actually waiting —
              an empty queue is not news. */}
          {suggestionCount > 0 && (
            <Button
              type="button"
              variant="outline"
              onClick={() => void openSuggestions()}
              className="gap-2 border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 hover:text-amber-800"
            >
              <RefreshCcwDot className="h-4 w-4" />
              {suggestionCount} הצעות מבלינק
            </Button>
          )}
          {canEdit && (
            <Button type="button" onClick={() => setShowImport(true)}
              className="gap-2">
              <Upload className="h-4 w-4" /> ייבוא Excel
            </Button>
          )}
          <Button type="button" variant="outline" onClick={exportCsv} className="gap-2">
            <Download className="h-4 w-4" /> ייצוא CSV
          </Button>
          {canEdit && (
            <Button type="button" onClick={openCreate} className="gap-2">
              <Plus className="h-4 w-4" /> דייר חדש
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-3 rounded-lg border bg-card p-4">
        {/* Registry coverage summary — each count filters the table (client-side) */}
        <div className="flex flex-wrap items-center gap-2">
          <SummaryChip
            active={quickFilter === 'all'}
            onClick={() => setQuickFilter('all')}
            label={`${summary.total} דירות במרשם`}
          />
          <span className="text-slate-300">·</span>
          <SummaryChip
            active={quickFilter === 'no_contact'}
            onClick={() => setQuickFilter((f) => (f === 'no_contact' ? 'all' : 'no_contact'))}
            label={`${summary.noContact} ללא איש קשר`}
            title="שם וטלפון ריקים בכל שלושת התפקידים (בעלים / שוכר / מפעיל)"
          />
          <span className="text-slate-300">·</span>
          <SummaryChip
            active={quickFilter === 'needs_review'}
            onClick={() => setQuickFilter((f) => (f === 'needs_review' ? 'all' : 'needs_review'))}
            label={`${summary.needsReview} דורשות בדיקה`}
            title="דירות שנוצרו אוטומטית מייבוא/סנכרון וטרם נבדקו"
          />
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400 start-3" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="חיפוש לפי דירה, שם, טלפון..."
            className="h-10 ps-9"
          />
        </div>

        {/* Tag filters */}
        {allTags.length > 0 && (
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {allTags.map((tag) => {
              const active = selectedTags.includes(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  onClick={() => toggleTag(tag)}
                  className={cn(
                    'inline-flex shrink-0 items-center rounded-full px-3 py-0.5 text-xs font-medium transition-colors',
                    active
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200',
                  )}
                >
                  {tag}
                </button>
              );
            })}
          </div>
        )}

        <ContactsTable rows={visibleContacts} loading={loading} canEdit={canEdit} onRowClick={openEdit} />
      </div>

      <ContactSuggestionsPanel
        open={showSuggestions}
        items={suggestions}
        canEdit={canEdit}
        onOpenChange={setShowSuggestions}
        onChanged={(items) => {
          setSuggestions(items);
          setSuggestionCount(items.length);
          // An approval wrote into contacts — reload so the table shows it.
          void fetchContacts();
        }}
      />

      <ContactImportPanel
        open={showImport}
        onOpenChange={setShowImport}
        onImported={fetchContacts}
      />

      <ContactFormPanel
        open={formOpen}
        contact={editingContact}
        canEdit={canEdit}
        canViewParking={canViewParking}
        canEditParking={canEditParking}
        onOpenChange={(o) => { setFormOpen(o); if (!o) setEditingContact(null); }}
        onSaved={fetchContacts}
      />
    </div>
  );
}

function SummaryChip({
  active,
  onClick,
  label,
  title,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'inline-flex h-9 items-center rounded-full px-4 text-[13px] font-semibold tabular-nums transition-colors',
        active
          ? 'bg-blue-600 text-white'
          : 'bg-slate-100 text-slate-600 hover:bg-slate-200',
      )}
    >
      {label}
    </button>
  );
}
