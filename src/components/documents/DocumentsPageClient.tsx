'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Plus, Upload, Search, FolderOpen, ChevronLeft, UploadCloud,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import type { DocumentFolderWithMeta, DocumentWithSignedUrl } from '@/lib/types/documents';
import { FolderCard } from './FolderCard';
import { DocumentCard } from './DocumentCard';
import { FolderFormPanel } from './FolderFormPanel';
import { DocumentRenamePanel } from './DocumentRenamePanel';
import { UploadPanel } from './UploadPanel';
import { documentErrorMessage } from './helpers';

type SortKey = 'name' | 'date';
interface Crumb { id: string; name: string }
interface DeleteTarget { kind: 'folder' | 'document'; id: string; name: string }

export function DocumentsPageClient({ canEdit }: { canEdit: boolean }) {
  const [folders, setFolders] = useState<DocumentFolderWithMeta[]>([]);
  const [documents, setDocuments] = useState<DocumentWithSignedUrl[]>([]);
  const [loading, setLoading] = useState(true);
  const [path, setPath] = useState<Crumb[]>([]);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('name');
  const [dragging, setDragging] = useState(false);

  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [renameFolder, setRenameFolder] = useState<{ id: string; name: string } | null>(null);
  const [renameDoc, setRenameDoc] = useState<{ id: string; name: string } | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleting, setDeleting] = useState(false);

  const currentFolderId = path.length ? path[path.length - 1].id : null;
  const currentFolderName = path.length ? path[path.length - 1].name : 'תיקייה ראשית';

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const parentParam = currentFolderId ?? 'root';
      const folderParam = currentFolderId ?? 'unfiled';
      const [fRes, dRes] = await Promise.all([
        fetch(`/api/documents/folders?parentId=${parentParam}`, { credentials: 'include' }),
        fetch(`/api/documents?folderId=${folderParam}`, { credentials: 'include' }),
      ]);
      if (!fRes.ok) throw new Error(`HTTP ${fRes.status}`);
      if (!dRes.ok) throw new Error(`HTTP ${dRes.status}`);
      const fData = (await fRes.json()) as { folders?: DocumentFolderWithMeta[] };
      const dData = (await dRes.json()) as { documents?: DocumentWithSignedUrl[] };
      setFolders(Array.isArray(fData.folders) ? fData.folders : []);
      setDocuments(Array.isArray(dData.documents) ? dData.documents : []);
    } catch (err) {
      toast.error(`טעינת המסמכים נכשלה: ${(err as Error).message}`);
      setFolders([]);
      setDocuments([]);
    } finally {
      setLoading(false);
    }
  }, [currentFolderId]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  // ── Navigation ──────────────────────────────────────────────────────────
  function enterFolder(folder: DocumentFolderWithMeta) {
    setSearch('');
    setPath((prev) => [...prev, { id: folder.id, name: folder.name }]);
  }
  function goToCrumb(index: number) {
    setSearch('');
    setPath((prev) => (index < 0 ? [] : prev.slice(0, index + 1)));
  }

  // ── Upload entry points ─────────────────────────────────────────────────
  function openUpload(files: File[]) {
    setUploadFiles(files);
    setUploadOpen(true);
  }

  function openFile(doc: DocumentWithSignedUrl) {
    // Download via our proxy route — it sets Content-Disposition (the Hebrew
    // file_name + real extension, RFC 5987) and Content-Type (mime_type), so the
    // file saves with the readable name and opens correctly. Same-origin link
    // carries the session cookie; the server's attachment disposition keeps the
    // app page in place.
    const a = document.createElement('a');
    a.href = `/api/documents/${doc.id}/download`;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ── Delete (soft) ───────────────────────────────────────────────────────
  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const url =
        deleteTarget.kind === 'folder'
          ? `/api/documents/folders/${deleteTarget.id}`
          : `/api/documents/${deleteTarget.id}`;
      const res = await fetch(url, { method: 'DELETE', credentials: 'include' });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(documentErrorMessage(data.error));
      }
      toast.success(deleteTarget.kind === 'folder' ? 'התיקייה הועברה לארכיון' : 'הקובץ נמחק');
      setDeleteTarget(null);
      await fetchData();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setDeleting(false);
    }
  }

  // ── Derived (filter + sort) ───────────────────────────────────────────────
  const q = search.trim().toLowerCase();
  const visibleFolders = folders
    .filter((f) => !q || f.name.toLowerCase().includes(q))
    .sort((a, b) =>
      sort === 'name' ? a.name.localeCompare(b.name, 'he') : b.created_at.localeCompare(a.created_at),
    );
  const visibleDocs = documents
    .filter((d) => !q || d.file_name.toLowerCase().includes(q))
    .sort((a, b) =>
      sort === 'name'
        ? a.file_name.localeCompare(b.file_name, 'he')
        : b.created_at.localeCompare(a.created_at),
    );
  const totalVisible = visibleFolders.length + visibleDocs.length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-extrabold text-slate-900">מסמכים</h1>
          <span className="text-sm text-muted-foreground">ניהול קבצים ומסמכים מרכזיים</span>
          <span className="inline-flex items-center justify-center rounded-full bg-slate-100 px-2 py-0.5 font-num text-xs font-bold text-slate-600 tabular-nums">
            {totalVisible}
          </span>
        </div>

        {canEdit && (
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" onClick={() => openUpload([])} className="gap-2">
              <Upload className="h-4 w-4" />
              העלאת קובץ
            </Button>
            <Button type="button" onClick={() => setShowCreateFolder(true)} className="gap-2">
              <Plus className="h-4 w-4" />
              תיקייה חדשה
            </Button>
          </div>
        )}
      </div>

      {/* Toolbar + content */}
      <div className="space-y-4 rounded-lg border bg-card p-4">
        {/* Search + sort */}
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="relative w-full md:w-72">
            <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="חיפוש בקבצים..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pe-9"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">מיון</span>
            <Select value={sort} onValueChange={(v) => { if (v) setSort(v as SortKey); }}>
              <SelectTrigger className="w-36 data-[size=default]:h-10">
                <SelectValue>
                  {(value: string | null) => (value === 'date' ? 'תאריך' : 'שם')}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="name">שם</SelectItem>
                <SelectItem value="date">תאריך</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Breadcrumb */}
        <nav className="flex flex-wrap items-center gap-1 text-sm" aria-label="ניווט תיקיות">
          <button
            type="button"
            onClick={() => goToCrumb(-1)}
            className={cn(
              'rounded-md px-2 py-1 transition-colors hover:bg-row-hover',
              path.length === 0 ? 'font-semibold text-ink' : 'text-ink-2',
            )}
          >
            מסמכים
          </button>
          {path.map((crumb, i) => (
            <span key={crumb.id} className="flex items-center gap-1">
              <ChevronLeft className="h-4 w-4 text-ink-ghost" />
              <button
                type="button"
                onClick={() => goToCrumb(i)}
                className={cn(
                  'max-w-[200px] truncate rounded-md px-2 py-1 transition-colors hover:bg-row-hover',
                  i === path.length - 1 ? 'font-semibold text-ink' : 'text-ink-2',
                )}
              >
                {crumb.name}
              </button>
            </span>
          ))}
        </nav>

        {/* Dropzone (edit only) */}
        {canEdit && (
          <button
            type="button"
            onClick={() => openUpload([])}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              if (e.dataTransfer.files.length) openUpload(Array.from(e.dataTransfer.files));
            }}
            className={cn(
              'flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors',
              dragging ? 'border-brand bg-brand-soft/60' : 'border-line-strong bg-surface-2 hover:border-brand hover:bg-brand-soft/40',
            )}
          >
            <span className="grid h-12 w-12 place-items-center rounded-full bg-brand-soft text-brand">
              <UploadCloud className="h-5 w-5" />
            </span>
            <span className="text-sm font-semibold text-ink">גרור קבצים או העלה</span>
            <span className="text-xs text-ink-3">שחרר קבצים כאן, או לחץ לבחירה ידנית</span>
          </button>
        )}

        {/* Content */}
        {loading ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-[76px] animate-pulse rounded-xl bg-muted/60" />
            ))}
          </div>
        ) : totalVisible === 0 ? (
          <EmptyState hasSearch={!!q} canEdit={canEdit} />
        ) : (
          <div className="space-y-6">
            {visibleFolders.length > 0 && (
              <section className="space-y-2">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-3">תיקיות</h2>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {visibleFolders.map((folder) => (
                    <FolderCard
                      key={folder.id}
                      folder={folder}
                      canEdit={canEdit}
                      onOpen={() => enterFolder(folder)}
                      onRename={() => setRenameFolder({ id: folder.id, name: folder.name })}
                      onDelete={() => setDeleteTarget({ kind: 'folder', id: folder.id, name: folder.name })}
                    />
                  ))}
                </div>
              </section>
            )}

            {visibleDocs.length > 0 && (
              <section className="space-y-2">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-3">קבצים</h2>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {visibleDocs.map((doc) => (
                    <DocumentCard
                      key={doc.id}
                      doc={doc}
                      canEdit={canEdit}
                      onOpen={() => openFile(doc)}
                      onRename={() => setRenameDoc({ id: doc.id, name: doc.file_name })}
                      onDelete={() => setDeleteTarget({ kind: 'document', id: doc.id, name: doc.file_name })}
                    />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>

      {/* Panels (edit only) */}
      {canEdit && (
        <>
          <FolderFormPanel
            open={showCreateFolder}
            parentFolderId={currentFolderId}
            onOpenChange={setShowCreateFolder}
            onSaved={fetchData}
          />
          <FolderFormPanel
            open={!!renameFolder}
            folder={renameFolder}
            onOpenChange={(o) => { if (!o) setRenameFolder(null); }}
            onSaved={fetchData}
          />
          <DocumentRenamePanel
            open={!!renameDoc}
            doc={renameDoc}
            onOpenChange={(o) => { if (!o) setRenameDoc(null); }}
            onSaved={fetchData}
          />
          <UploadPanel
            open={uploadOpen}
            folderId={currentFolderId}
            folderName={currentFolderName}
            initialFiles={uploadFiles}
            onOpenChange={setUploadOpen}
            onUploaded={fetchData}
          />

          <AlertDialog open={!!deleteTarget} onOpenChange={(o) => { if (!o && !deleting) setDeleteTarget(null); }}>
            <AlertDialogContent dir="rtl">
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {deleteTarget?.kind === 'folder' ? 'מחיקת תיקייה?' : 'מחיקת קובץ?'}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {deleteTarget?.kind === 'folder' ? (
                    <>
                      התיקייה <span className="font-semibold">{deleteTarget?.name}</span> תועבר לארכיון.
                      קבצים ותיקיות בתוכה לא יימחקו.
                    </>
                  ) : (
                    <>
                      הקובץ <span className="font-semibold">{deleteTarget?.name}</span> יימחק (העברה לארכיון).
                    </>
                  )}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={deleting}>ביטול</AlertDialogCancel>
                <AlertDialogAction
                  onClick={(e) => { e.preventDefault(); void confirmDelete(); }}
                  disabled={deleting}
                  className="bg-destructive text-white hover:bg-destructive/90"
                >
                  {deleting ? 'מוחק…' : 'מחק'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </div>
  );
}

function EmptyState({ hasSearch, canEdit }: { hasSearch: boolean; canEdit: boolean }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border bg-card p-12 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-full bg-slate-100 text-slate-400">
        <FolderOpen className="h-6 w-6" />
      </span>
      <p className="text-sm text-muted-foreground">
        {hasSearch
          ? 'לא נמצאו תוצאות לחיפוש.'
          : canEdit
            ? 'אין כאן עדיין תיקיות או קבצים. צור תיקייה או העלה קובץ כדי להתחיל.'
            : 'אין כאן עדיין תיקיות או קבצים.'}
      </p>
    </div>
  );
}
