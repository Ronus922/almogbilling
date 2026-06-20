'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  X, Building2, MapPin, CreditCard, FileText, Activity, Phone,
  StickyNote, Pencil, Power, Archive, Trash2,
  Upload, Download, Image as ImageIcon, FileSpreadsheet, File as FileIcon, Eye,
} from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { SupplierSection } from './SupplierSection';
import { SupplierActivity } from './SupplierActivity';
import { SupplierField, ReadonlyField, FIELD_LABEL } from './SupplierField';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { cn } from '@/lib/utils';
import { validatePhone } from '@/lib/validation';
import { formatPhoneDisplay } from '@/lib/phone';
import {
  supplierStatusMeta,
  PAYMENT_TERMS, paymentTermsLabel,
  DOC_TYPES, docTypeLabel, ALLOWED_DOC_TYPES, MAX_DOC_SIZE_BYTES,
} from '@/lib/constants/suppliers';
import type {
  Supplier, SupplierDocument, SupplierWritableFields,
  SupplierStatus, SupplierPaymentTerms, SupplierDocType, SupplierCategory,
} from '@/lib/types/suppliers';

// Sentinel for "no category" — base-ui Select needs a non-empty value.
const NONE = '__none__';

interface Props {
  supplierId: string | null;
  open: boolean;
  categories: SupplierCategory[];
  onOpenChange: (o: boolean) => void;
  onChanged: () => void;
  canEdit: boolean;
  canDelete: boolean;
}

type FormState = SupplierWritableFields;

function toForm(s: Supplier): FormState {
  return {
    display_name: s.display_name,
    company_name: s.company_name,
    contact_person: s.contact_person,
    supplier_type: s.supplier_type,
    category_id: s.category_id,
    status: s.status,
    phone: s.phone,
    mobile: s.mobile,
    email: s.email,
    website: s.website,
    address: s.address,
    city: s.city,
    tax_id: s.tax_id,
    bank_name: s.bank_name,
    bank_branch: s.bank_branch,
    bank_account: s.bank_account,
    payment_terms: s.payment_terms,
    notes: s.notes,
    internal_notes: s.internal_notes,
    rating: s.rating,
  };
}

export function SupplierDetailPanel({
  supplierId, open, categories, onOpenChange, onChanged, canEdit, canDelete,
}: Props) {
  const router = useRouter();
  const [supplier, setSupplier] = useState<Supplier | null>(null);
  const [documents, setDocuments] = useState<SupplierDocument[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<FormState | null>(null);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);

  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [confirmDeleteDocId, setConfirmDeleteDocId] = useState<string | null>(null);

  // Documents upload row state.
  const [uploadDocType, setUploadDocType] = useState<SupplierDocType>('general');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadName, setUploadName] = useState('');
  const [uploading, setUploading] = useState(false);

  // Rename-document dialog (single-field edit → Dialog per DESIGN law).
  const [renameDoc, setRenameDoc] = useState<SupplierDocument | null>(null);

  // Bumped after any mutation so the Activity tab refetches its log.
  const [activityVersion, setActivityVersion] = useState(0);
  function bumpActivity() {
    setActivityVersion((v) => v + 1);
  }

  // Fetch supplier + documents on open.
  useEffect(() => {
    if (!open || !supplierId) {
      setSupplier(null);
      setDocuments([]);
      setError(null);
      setEditing(false);
      setForm(null);
      setTouched({});
      return;
    }
    let cancelled = false;
    setLoading(true); setError(null); setEditing(false); setForm(null); setTouched({});
    Promise.all([
      fetch(`/api/suppliers/${supplierId}`, { credentials: 'include' })
        .then((r) => r.ok ? r.json() : Promise.reject(new Error(`supplier HTTP ${r.status}`))),
      fetch(`/api/suppliers/${supplierId}/documents`, { credentials: 'include' })
        .then((r) => r.ok ? r.json() : Promise.reject(new Error(`documents HTTP ${r.status}`))),
    ])
      .then(([sup, docs]: [{ supplier: Supplier }, { documents: SupplierDocument[] }]) => {
        if (cancelled) return;
        setSupplier(sup.supplier);
        setDocuments(docs.documents ?? []);
      })
      .catch((err: Error) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, supplierId]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  function markTouched(key: keyof FormState) {
    setTouched((prev) => ({ ...prev, [key]: true }));
  }

  const errors = useMemo(() => {
    const e: Partial<Record<keyof FormState, string>> = {};
    if (!form) return e;
    if (!form.display_name.trim()) e.display_name = 'שם תצוגה הוא שדה חובה';
    if (form.phone.trim() && !validatePhone(form.phone).valid) {
      e.phone = validatePhone(form.phone).error ?? 'מספר טלפון לא תקין';
    }
    if (form.mobile.trim() && !validatePhone(form.mobile).valid) {
      e.mobile = validatePhone(form.mobile).error ?? 'מספר טלפון לא תקין';
    }
    return e;
  }, [form]);

  function errFor(key: keyof FormState): string | null {
    return touched[key] ? errors[key] ?? null : null;
  }

  const canSaveEdit = !!form && !errors.display_name && !errors.phone && !errors.mobile && !saving;

  const isDirty = editing; // edit mode is the only unsaved-state surface

  useEscapeKey(open && !confirmCloseOpen && !confirmDeleteOpen && confirmDeleteDocId === null && renameDoc === null, () => requestClose());
  useEscapeKey(confirmCloseOpen, () => setConfirmCloseOpen(false));
  useEscapeKey(confirmDeleteOpen, () => setConfirmDeleteOpen(false));
  useEscapeKey(confirmDeleteDocId !== null, () => setConfirmDeleteDocId(null));

  function requestClose() {
    if (saving) return;
    if (isDirty) setConfirmCloseOpen(true);
    else onOpenChange(false);
  }

  function confirmDiscardClose() {
    setConfirmCloseOpen(false);
    setEditing(false);
    onOpenChange(false);
  }

  function startEdit() {
    if (!supplier) return;
    setForm(toForm(supplier));
    setTouched({});
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setForm(null);
    setTouched({});
  }

  // Whole-object PATCH. Used for both edit-save and status changes.
  async function patchSupplier(fields: SupplierWritableFields, successMsg: string): Promise<boolean> {
    if (!supplierId) return false;
    const r = await fetch(`/api/suppliers/${supplierId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(fields),
    });
    const data = (await r.json().catch(() => ({}))) as { supplier?: Supplier; error?: string };
    if (!r.ok) throw new Error(data.error ?? 'שמירה נכשלה');
    if (data.supplier) setSupplier(data.supplier);
    toast.success(successMsg);
    bumpActivity();
    onChanged();
    router.refresh();
    return true;
  }

  async function handleSaveEdit() {
    if (!form) return;
    if (!canSaveEdit) {
      setTouched({ display_name: true, phone: true, mobile: true });
      return;
    }
    setSaving(true);
    try {
      const payload: SupplierWritableFields = {
        ...form,
        display_name: form.display_name.trim(),
        company_name: form.company_name.trim(),
        contact_person: form.contact_person.trim(),
        phone: form.phone.trim() ? validatePhone(form.phone).normalized : '',
        mobile: form.mobile.trim() ? validatePhone(form.mobile).normalized : '',
        email: form.email.trim(),
        website: form.website.trim(),
        address: form.address.trim(),
        city: form.city.trim(),
        tax_id: form.tax_id.trim(),
        bank_name: form.bank_name.trim(),
        bank_branch: form.bank_branch.trim(),
        bank_account: form.bank_account.trim(),
        notes: form.notes.trim(),
        internal_notes: form.internal_notes.trim(),
      };
      await patchSupplier(payload, 'הספק עודכן');
      setEditing(false);
      setForm(null);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleStatusChange(next: SupplierStatus) {
    if (!supplier || saving) return;
    setSaving(true);
    try {
      await patchSupplier({ ...toForm(supplier), status: next }, 'הסטטוס עודכן');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!supplierId) return;
    setSaving(true);
    try {
      const r = await fetch(`/api/suppliers/${supplierId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!r.ok) {
        const data = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? 'מחיקה נכשלה');
      }
      toast.success('הספק נמחק');
      onChanged();
      router.refresh();
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
      setConfirmDeleteOpen(false);
    }
  }

  async function handleUpload() {
    if (!supplierId || !uploadFile || uploading) return;

    if (!ALLOWED_DOC_TYPES.includes(uploadFile.type)) {
      toast.error('סוג קובץ לא נתמך');
      return;
    }
    if (uploadFile.size > MAX_DOC_SIZE_BYTES) {
      toast.error('הקובץ גדול מדי (מקסימום 10MB)');
      return;
    }

    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', uploadFile);
      fd.append('doc_type', uploadDocType);
      fd.append('file_name', uploadName.trim() || uploadFile.name);
      const r = await fetch(`/api/suppliers/${supplierId}/documents`, {
        method: 'POST',
        credentials: 'include',
        body: fd,
      });
      const data = (await r.json().catch(() => ({}))) as { document?: SupplierDocument; error?: string };
      if (!r.ok || !data.document) throw new Error(data.error ?? 'העלאה נכשלה');
      setDocuments((prev) => [data.document as SupplierDocument, ...prev]);
      setUploadFile(null);
      setUploadName('');
      setUploadDocType('general');
      toast.success('המסמך הועלה');
      bumpActivity();
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function handleViewDocument(docId: string) {
    if (!supplierId) return;
    try {
      const r = await fetch(`/api/suppliers/${supplierId}/documents/${docId}`, { credentials: 'include' });
      const data = (await r.json().catch(() => ({}))) as { signed_url?: string; error?: string };
      if (!r.ok || !data.signed_url) throw new Error(data.error ?? 'קישור לא זמין');
      window.open(data.signed_url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function handleDeleteDocument(docId: string) {
    if (!supplierId) return;
    try {
      const r = await fetch(`/api/suppliers/${supplierId}/documents/${docId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!r.ok) {
        const data = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? 'מחיקה נכשלה');
      }
      setDocuments((prev) => prev.filter((d) => d.id !== docId));
      toast.success('המסמך נמחק');
      bumpActivity();
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setConfirmDeleteDocId(null);
    }
  }

  async function handleRenameDocument(docId: string, fileName: string) {
    if (!supplierId) return;
    const r = await fetch(`/api/suppliers/${supplierId}/documents/${docId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ file_name: fileName }),
    });
    const data = (await r.json().catch(() => ({}))) as { document?: SupplierDocument; error?: string };
    if (!r.ok || !data.document) throw new Error(data.error ?? 'שינוי השם נכשל');
    const updated = data.document;
    setDocuments((prev) => prev.map((d) => (d.id === docId ? { ...d, file_name: updated.file_name } : d)));
    toast.success('שם המסמך עודכן');
    bumpActivity();
    onChanged();
  }

  const statusMeta = supplier ? supplierStatusMeta(supplier.status) : null;
  const headerCategoryName =
    supplier?.category_id
      ? categories.find((c) => c.id === supplier.category_id)?.name ?? null
      : null;

  return (
    <>
      <Sheet open={open} onOpenChange={(o) => { if (!o) requestClose(); else onOpenChange(o); }}>
        <SheetContent
          side="left"
          dir="rtl"
          showCloseButton={false}
          className="w-full p-0 sm:w-[55vw] md:min-w-[720px] flex flex-col gap-0 overflow-hidden bg-white"
        >
          {/* Header — DETAIL family (navy diagonal gradient) */}
          <SheetHeader className="flex-none gap-2 bg-[linear-gradient(120deg,#0e1f4d_0%,#16308a_55%,#1d4ed8_100%)] px-8 py-5 text-white">
            {loading ? (
              <div className="space-y-2">
                <div className="h-8 w-56 rounded bg-white/10 animate-pulse" />
                <div className="h-4 w-72 rounded bg-white/10 animate-pulse" />
              </div>
            ) : supplier && statusMeta ? (
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <SheetTitle className="text-[26px] font-extrabold text-white">
                    {supplier.display_name}
                  </SheetTitle>
                  <p className="mt-[6px] inline-flex items-center gap-[7px] text-[13.5px] font-medium text-[#c7dbff]/80">
                    <Building2 className="h-[15px] w-[15px]" />
                    {headerCategoryName ?? 'ללא קטגוריה'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={requestClose}
                  aria-label="סגור"
                  className="flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-[13px] bg-white/[0.14] text-white transition-colors hover:bg-white/[0.26]"
                >
                  <X className="h-5 w-5" strokeWidth={2.2} />
                </button>
              </div>
            ) : null}
          </SheetHeader>

          {/* Body */}
          <div className="flex-1 overflow-y-auto bg-[#f4f6fb] p-6">
            {error ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
                שגיאה בטעינת הפרטים: {error}
              </div>
            ) : loading || !supplier ? (
              <div className="space-y-4">
                <div className="h-40 rounded-xl bg-muted/60 animate-pulse" />
                <div className="h-40 rounded-xl bg-muted/60 animate-pulse" />
              </div>
            ) : (
              <Tabs defaultValue="details" className="w-full">
                {/* DESIGN.md §28.3 in-sheet tab-bar — white card + blue active pill. */}
                <TabsList className="grid w-full grid-cols-3 gap-[8px] rounded-[14px] border border-[#e9edf4] bg-white p-[6px] group-data-horizontal/tabs:h-auto">
                  {[
                    { value: 'details', icon: Building2, label: 'פרטים' },
                    { value: 'documents', icon: FileText, label: 'מסמכים' },
                    { value: 'activity', icon: Activity, label: 'פעילות' },
                  ].map(({ value, icon: TabIcon, label }) => (
                    <TabsTrigger
                      key={value}
                      value={value}
                      className="h-[42px] gap-2 rounded-[10px] text-[14.5px] font-semibold text-[#64748b] data-active:bg-[#2563eb] data-active:font-bold data-active:text-white group-data-[variant=default]/tabs-list:data-active:shadow-none"
                    >
                      <TabIcon className="h-4 w-4" /> {label}
                    </TabsTrigger>
                  ))}
                </TabsList>

                {/* TAB — פרטים */}
                <TabsContent value="details" className="mt-5 space-y-4">
                  {editing && form ? (
                    <EditForm
                      form={form}
                      set={set}
                      markTouched={markTouched}
                      errFor={errFor}
                      categories={categories}
                      disabled={saving}
                    />
                  ) : (
                    <ViewDetails supplier={supplier} categories={categories} />
                  )}
                </TabsContent>

                {/* TAB — מסמכים */}
                <TabsContent value="documents" className="mt-5 space-y-4">
                  {canEdit && (
                    <SupplierSection title="העלאת מסמך" icon={Upload} iconTone="blue">
                      <div className="space-y-3 py-2">
                        <div className="space-y-2">
                          <Label className={FIELD_LABEL}>סוג מסמך</Label>
                          <Select
                            value={uploadDocType}
                            onValueChange={(v) => { if (v) setUploadDocType(v as SupplierDocType); }}
                            disabled={uploading}
                          >
                            <SelectTrigger className="w-full rounded-[11px] border-[#e2e8f0] data-[size=default]:h-[46px]">
                              <SelectValue placeholder="בחר סוג...">
                                {(value: string | null) => (value ? docTypeLabel(value) : null)}
                              </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              {DOC_TYPES.map((d) => (
                                <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        {/* DESIGN.md §28.5 upload dropzone */}
                        <div className="space-y-2">
                          <Label htmlFor="sup-doc-file" className={FIELD_LABEL}>קובץ</Label>
                          <label
                            htmlFor="sup-doc-file"
                            aria-disabled={uploading}
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={(e) => {
                              e.preventDefault();
                              if (uploading) return;
                              const f = e.dataTransfer.files?.[0] ?? null;
                              if (f) { setUploadFile(f); setUploadName(f.name); }
                            }}
                            className="flex cursor-pointer flex-col items-center gap-2 rounded-[14px] border-2 border-dashed border-[#d8e0ec] bg-[#fafbfd] p-[26px] text-center transition-colors hover:border-[#93b4f0] hover:bg-[#f5f9ff] aria-disabled:pointer-events-none aria-disabled:opacity-60"
                          >
                            <span className="grid h-12 w-12 place-items-center rounded-[13px] bg-[#e8f0ff] text-[#2563eb]">
                              <Upload className="h-[22px] w-[22px]" />
                            </span>
                            <span className="text-sm font-semibold text-[#334155]">
                              {uploadFile ? uploadFile.name : 'גררו קובץ לכאן או לחצו לבחירה'}
                            </span>
                            <span className="text-[12.5px] text-[#94a3b8]">
                              עד 10MB · תמונות, PDF, Word או Excel
                            </span>
                            <input
                              id="sup-doc-file"
                              type="file"
                              disabled={uploading}
                              accept={ALLOWED_DOC_TYPES.join(',')}
                              onChange={(e) => {
                                const f = e.target.files?.[0] ?? null;
                                setUploadFile(f);
                                setUploadName(f ? f.name : '');
                              }}
                              className="sr-only"
                            />
                          </label>
                        </div>
                        {uploadFile && (
                          <div className="space-y-2">
                            <Label htmlFor="sup-doc-name" className={FIELD_LABEL}>
                              שם המסמך
                            </Label>
                            <Input
                              id="sup-doc-name"
                              value={uploadName}
                              onChange={(e) => setUploadName(e.target.value)}
                              disabled={uploading}
                              placeholder="שם לתצוגה"
                              className="h-[46px] rounded-[11px] border-[#e2e8f0]"
                            />
                          </div>
                        )}
                        <div className="flex justify-start">
                          <Button
                            type="button"
                            onClick={handleUpload}
                            disabled={!uploadFile || uploading}
                            className="h-[46px] gap-2 rounded-[12px] bg-gradient-to-l from-[#1d4ed8] to-[#2563eb] px-[22px] text-[14.5px] font-bold text-white shadow-[0_8px_18px_-6px_rgba(37,99,235,0.5)] hover:from-[#1e40af] hover:to-[#1d4ed8]"
                          >
                            <Upload className="h-4 w-4" />
                            {uploading ? 'מעלה…' : 'העלה מסמך'}
                          </Button>
                        </div>
                      </div>
                    </SupplierSection>
                  )}

                  <SupplierSection title="מסמכים" icon={FileText} iconTone="slate">
                    {documents.length === 0 ? (
                      <p className="py-6 text-center text-sm text-muted-foreground">
                        אין מסמכים עדיין.
                      </p>
                    ) : (
                      <div className="space-y-2 py-2">
                        {documents.map((doc) => (
                          <DocumentRow
                            key={doc.id}
                            doc={doc}
                            canEdit={canEdit}
                            canDelete={canDelete}
                            onView={() => handleViewDocument(doc.id)}
                            onRename={() => setRenameDoc(doc)}
                            onDelete={() => setConfirmDeleteDocId(doc.id)}
                          />
                        ))}
                      </div>
                    )}
                  </SupplierSection>
                </TabsContent>

                {/* TAB — פעילות (automatic log from the central audit_log) */}
                <TabsContent value="activity" className="mt-5">
                  <SupplierActivity supplierId={supplier.id} refreshSignal={activityVersion} />
                </TabsContent>
              </Tabs>
            )}
          </div>

          {/* Footer — view mode actions (sticky, matches view.html) */}
          {!loading && supplier && !editing && (canEdit || canDelete) && (
            <footer className="flex-none flex items-center justify-between gap-3 border-t border-[#e7ebf1] bg-white px-8 py-[14px]">
              {/* right (RTL start): delete + archive/restore */}
              <div className="flex items-center gap-[10px]">
                {canDelete && (
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteOpen(true)}
                    disabled={saving}
                    className="inline-flex h-11 items-center gap-2 rounded-[11px] border border-[#fecaca] bg-white px-[18px] text-[14px] font-semibold text-[#dc2626] transition-colors hover:border-[#fca5a5] hover:bg-[#fef2f2] disabled:opacity-50"
                  >
                    <Trash2 className="h-4 w-4" />
                    מחק ספק
                  </button>
                )}
                {canEdit && supplier.status === 'active' && (
                  <button
                    type="button"
                    onClick={() => handleStatusChange('archived')}
                    disabled={saving}
                    className="inline-flex h-11 items-center gap-2 rounded-[11px] border border-[#fcd9a8] bg-white px-[18px] text-[14px] font-semibold text-[#c2700a] transition-colors hover:border-[#f8c574] hover:bg-[#fff8ee] disabled:opacity-50"
                  >
                    <Archive className="h-4 w-4" />
                    העבר לארכיון
                  </button>
                )}
                {canEdit && supplier.status === 'archived' && (
                  <button
                    type="button"
                    onClick={() => handleStatusChange('active')}
                    disabled={saving}
                    className="inline-flex h-11 items-center gap-2 rounded-[11px] border border-[#bbf7d0] bg-white px-[18px] text-[14px] font-semibold text-[#15803d] transition-colors hover:border-[#86efac] hover:bg-[#f0fdf4] disabled:opacity-50"
                  >
                    <Power className="h-4 w-4" />
                    שחזר מארכיון
                  </button>
                )}
              </div>
              {/* left (RTL end): edit (gradient primary) */}
              {canEdit && (
                <button
                  type="button"
                  onClick={startEdit}
                  disabled={saving}
                  className="inline-flex h-11 items-center gap-2 rounded-[11px] bg-gradient-to-l from-[#1d4ed8] to-[#2563eb] px-[24px] text-[14px] font-bold text-white shadow-[0_8px_18px_-6px_rgba(37,99,235,0.5)] transition-colors hover:from-[#1e40af] hover:to-[#1d4ed8] disabled:opacity-50"
                >
                  <Pencil className="h-4 w-4" />
                  ערוך
                </button>
              )}
            </footer>
          )}

          {/* Footer — only in edit mode */}
          {!loading && supplier && editing && (
            <footer className="flex-none border-t border-slate-200 bg-white px-5 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  {canDelete && (
                    <Button
                      type="button"
                      variant="delete"
                      onClick={() => setConfirmDeleteOpen(true)}
                      disabled={saving}
                      className="gap-2"
                    >
                      <Trash2 className="h-4 w-4" />
                      מחק ספק
                    </Button>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button type="button" variant="outline" onClick={cancelEdit} disabled={saving}>
                    ביטול
                  </Button>
                  <Button
                    type="button"
                    onClick={handleSaveEdit}
                    disabled={!canSaveEdit}
                    className="gap-2 bg-gradient-to-l from-blue-700 to-blue-600 text-white hover:from-blue-800 hover:to-blue-700 shadow-[0_8px_18px_-6px_rgba(37,99,235,0.5)]"
                  >
                    {saving ? 'שומר…' : 'שמור שינויים'}
                  </Button>
                </div>
              </div>
            </footer>
          )}
        </SheetContent>
      </Sheet>

      {/* Confirm exit with unsaved changes */}
      <AlertDialog open={confirmCloseOpen} onOpenChange={setConfirmCloseOpen}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>האם לצאת ללא שמירה?</AlertDialogTitle>
            <AlertDialogDescription>
              ביצעת שינויים שלא נשמרו. אם תצא עכשיו, השינויים יאבדו.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>ביטול</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDiscardClose}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              צא ללא שמירה
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Confirm delete supplier */}
      <AlertDialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>למחוק את הספק?</AlertDialogTitle>
            <AlertDialogDescription>
              הספק יוסר מהרשימה. לא ניתן לבטל פעולה זו.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>ביטול</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              מחק
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Confirm delete document */}
      <AlertDialog open={confirmDeleteDocId !== null} onOpenChange={(o) => { if (!o) setConfirmDeleteDocId(null); }}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>למחוק את המסמך?</AlertDialogTitle>
            <AlertDialogDescription>
              הקובץ יימחק לצמיתות. לא ניתן לבטל פעולה זו.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>ביטול</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (confirmDeleteDocId) void handleDeleteDocument(confirmDeleteDocId); }}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              מחק
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Rename document — single-field edit (Dialog, per DESIGN law) */}
      <RenameDocumentDialog
        doc={renameDoc}
        onOpenChange={(o) => { if (!o) setRenameDoc(null); }}
        onSave={handleRenameDocument}
      />
    </>
  );
}

/* ---------- Rename document dialog (single-field edit) ---------- */

function RenameDocumentDialog({
  doc,
  onOpenChange,
  onSave,
}: {
  doc: SupplierDocument | null;
  onOpenChange: (open: boolean) => void;
  onSave: (docId: string, fileName: string) => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (doc) {
      setValue(doc.file_name);
      setError(null);
      setSaving(false);
    }
  }, [doc]);

  const trimmed = value.trim();
  const canSave = trimmed.length > 0 && !saving;

  async function handleSave() {
    if (!doc || !canSave) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(doc.id, trimmed);
      onOpenChange(false);
    } catch (err) {
      setError((err as Error).message || 'שינוי השם נכשל');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={doc !== null} onOpenChange={onOpenChange}>
      <DialogContent dir="rtl" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>שינוי שם מסמך</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="doc-rename-input" className="text-sm font-medium text-muted-foreground">
            שם המסמך
          </Label>
          <Input
            id="doc-rename-input"
            value={value}
            onChange={(e) => { setValue(e.target.value); setError(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && canSave) void handleSave(); }}
            disabled={saving}
            placeholder="שם לתצוגה"
            autoFocus
            className={cn('h-10', error && 'border-red-400 bg-red-50 focus-visible:ring-red-200')}
          />
          {error && (
            <p className="text-[12px] font-semibold text-red-500 text-right">⚠️ {error}</p>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>ביטול</Button>
          <Button onClick={handleSave} disabled={!canSave}>
            {saving ? 'שומר…' : 'שמור'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---------- View mode ---------- */

interface ViewProps {
  supplier: Supplier;
  categories: SupplierCategory[];
}

function ViewDetails({ supplier, categories }: ViewProps) {
  const categoryName = supplier.category_id
    ? categories.find((c) => c.id === supplier.category_id)?.name ?? null
    : null;
  return (
    <>
      {/* פרטי קשר — readonly boxes (DESIGN.md §28.8) */}
      <SupplierSection title="פרטי קשר" icon={Phone} iconTone="blue">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <ReadonlyField label="קטגוריה" value={categoryName} />
          <ReadonlyField label="איש קשר" value={supplier.contact_person || null} />
          <ReadonlyField label="טלפון" value={formatPhoneDisplay(supplier.phone)} ltr />
          <ReadonlyField label="נייד" value={formatPhoneDisplay(supplier.mobile)} ltr />
          <ReadonlyField label="אימייל" value={supplier.email || null} ltr accent />
          <ReadonlyField label="אתר" value={supplier.website || null} ltr accent />
        </div>
      </SupplierSection>

      {/* כתובת */}
      <SupplierSection title="כתובת" icon={MapPin} iconTone="amber">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <ReadonlyField label="כתובת" value={supplier.address || null} />
          <ReadonlyField label="עיר" value={supplier.city || null} />
          <ReadonlyField label="ח.פ / עוסק" value={supplier.tax_id || null} ltr />
        </div>
      </SupplierSection>

      {/* תנאי תשלום */}
      <SupplierSection title="תנאי תשלום" icon={CreditCard} iconTone="emerald">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <ReadonlyField label="תנאי תשלום" value={paymentTermsLabel(supplier.payment_terms)} />
          <ReadonlyField label="בנק" value={supplier.bank_name || null} />
          <ReadonlyField label="סניף" value={supplier.bank_branch || null} ltr />
          <ReadonlyField label="מספר חשבון" value={supplier.bank_account || null} ltr />
        </div>
      </SupplierSection>

      {/* הערות */}
      {supplier.notes && (
        <SupplierSection title="הערות" icon={StickyNote} iconTone="slate">
          <p className="whitespace-pre-wrap py-2 text-sm text-slate-700">{supplier.notes}</p>
        </SupplierSection>
      )}

      {/* internal_notes — distinct amber section (DESIGN §8 amber tone) */}
      {supplier.internal_notes && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-900">
          <div className="mb-2 flex items-center gap-2">
            <StickyNote className="h-4 w-4 text-amber-700" />
            <h3 className="text-base font-semibold">הערות פנימיות</h3>
          </div>
          <p className="whitespace-pre-wrap text-sm text-amber-900">{supplier.internal_notes}</p>
        </div>
      )}
    </>
  );
}

/* ---------- Edit mode (same 3 sections as create + internal_notes) ---------- */

interface EditFormProps {
  form: FormState;
  set: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
  markTouched: (key: keyof FormState) => void;
  errFor: (key: keyof FormState) => string | null;
  categories: SupplierCategory[];
  disabled: boolean;
}

function EditForm({ form, set, markTouched, errFor, categories, disabled }: EditFormProps) {
  return (
    <>
      {/* Section 1 — פרטי הספק */}
      <SupplierSection title="פרטי הספק" icon={Building2} iconTone="blue">
        <div className="grid grid-cols-1 gap-[14px] sm:grid-cols-2">
          <SupplierField
            id="esup-display-name" label="שם החברה" required
            value={form.display_name} onChange={(v) => set('display_name', v)}
            onBlur={() => markTouched('display_name')} error={errFor('display_name')} disabled={disabled}
          />
          <div className="space-y-1.5">
            <Label className={FIELD_LABEL}>קטגוריה</Label>
            <Select
              value={form.category_id ?? NONE}
              onValueChange={(v) => set('category_id', !v || v === NONE ? null : v)}
              disabled={disabled}
            >
              <SelectTrigger className="w-full rounded-[10px] border-[#e2e8f0] data-[size=default]:h-[42px]">
                <SelectValue placeholder="בחר קטגוריה...">
                  {(value: string | null) => {
                    if (!value || value === NONE) return 'ללא קטגוריה';
                    return categories.find((c) => c.id === value)?.name ?? 'קטגוריה';
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>ללא קטגוריה</SelectItem>
                {categories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <SupplierField
            id="esup-contact-person" label="איש קשר"
            value={form.contact_person} onChange={(v) => set('contact_person', v)} disabled={disabled}
          />
          <SupplierField
            id="esup-phone" label="טלפון"
            value={form.phone} onChange={(v) => set('phone', v)}
            onBlur={() => markTouched('phone')} error={errFor('phone')} disabled={disabled}
            inputMode="tel" dir="ltr" tabularNums placeholder="03-1234567"
          />
          <SupplierField
            id="esup-mobile" label="נייד"
            value={form.mobile} onChange={(v) => set('mobile', v)}
            onBlur={() => markTouched('mobile')} error={errFor('mobile')} disabled={disabled}
            inputMode="tel" dir="ltr" tabularNums placeholder="052-1234567"
          />
          <SupplierField
            id="esup-email" label="אימייל" type="email"
            value={form.email} onChange={(v) => set('email', v)} disabled={disabled}
            dir="ltr" placeholder="supplier@example.com"
          />
        </div>
      </SupplierSection>

      {/* Section 2 — כתובת ופרטים נוספים */}
      <SupplierSection title="כתובת ופרטים נוספים" icon={MapPin} iconTone="amber">
        <div className="grid grid-cols-1 gap-[14px] sm:grid-cols-2">
          <SupplierField id="esup-address" label="כתובת" value={form.address} onChange={(v) => set('address', v)} disabled={disabled} />
          <SupplierField id="esup-city" label="עיר" value={form.city} onChange={(v) => set('city', v)} disabled={disabled} />
          <SupplierField id="esup-website" label="אתר אינטרנט" value={form.website} onChange={(v) => set('website', v)} disabled={disabled} dir="ltr" placeholder="https://" />
          <SupplierField id="esup-tax-id" label="ח.פ / עוסק מורשה" value={form.tax_id} onChange={(v) => set('tax_id', v)} disabled={disabled} dir="ltr" tabularNums />
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="esup-notes" className={FIELD_LABEL}>הערות</Label>
            <Textarea
              id="esup-notes"
              value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
              disabled={disabled}
              className="min-h-[74px] rounded-[10px] border-[#e2e8f0] px-[13px] py-[11px] text-[14px]"
            />
          </div>
        </div>
      </SupplierSection>

      {/* Section 3 — תנאי תשלום */}
      <SupplierSection title="תנאי תשלום" icon={CreditCard} iconTone="emerald">
        <div className="grid grid-cols-1 gap-[14px] sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className={FIELD_LABEL}>תנאי תשלום</Label>
            <Select
              value={form.payment_terms}
              onValueChange={(v) => { if (v) set('payment_terms', v as SupplierPaymentTerms); }}
              disabled={disabled}
            >
              <SelectTrigger className="w-full rounded-[10px] border-[#e2e8f0] data-[size=default]:h-[42px]">
                <SelectValue placeholder="בחר תנאי תשלום...">
                  {(value: string | null) => (value ? paymentTermsLabel(value) : null)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {PAYMENT_TERMS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <SupplierField id="esup-bank-name" label="שם הבנק" value={form.bank_name} onChange={(v) => set('bank_name', v)} disabled={disabled} />
          <SupplierField id="esup-bank-branch" label="סניף" value={form.bank_branch} onChange={(v) => set('bank_branch', v)} disabled={disabled} dir="ltr" tabularNums />
          <SupplierField id="esup-bank-account" label="מספר חשבון" value={form.bank_account} onChange={(v) => set('bank_account', v)} disabled={disabled} dir="ltr" tabularNums />
        </div>
      </SupplierSection>

      {/* internal_notes — amber section in edit mode too */}
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
        <div className="mb-2 flex items-center gap-2 text-amber-900">
          <StickyNote className="h-4 w-4 text-amber-700" />
          <h3 className="text-base font-semibold">הערות פנימיות</h3>
        </div>
        <Textarea
          value={form.internal_notes}
          onChange={(e) => set('internal_notes', e.target.value)}
          disabled={disabled}
          className="min-h-24 border-amber-200 bg-white"
          placeholder="הערות שלא נחשפות לספק…"
        />
      </div>
    </>
  );
}

/* ---------- Document row ---------- */

interface DocRowProps {
  doc: SupplierDocument;
  canEdit: boolean;
  canDelete: boolean;
  onView: () => void;
  onRename: () => void;
  onDelete: () => void;
}

function iconForMime(mime: string): { Icon: typeof FileIcon; tone: string } {
  if (mime.startsWith('image/')) return { Icon: ImageIcon, tone: 'bg-blue-50 text-blue-600' };
  if (mime.includes('spreadsheet') || mime.includes('excel')) {
    return { Icon: FileSpreadsheet, tone: 'bg-emerald-50 text-emerald-600' };
  }
  if (mime === 'application/pdf') return { Icon: FileText, tone: 'bg-red-50 text-red-600' };
  return { Icon: FileIcon, tone: 'bg-slate-100 text-slate-500' };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value: Date | string): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('he-IL', {
    timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric',
  });
}

function DocumentRow({ doc, canEdit, canDelete, onView, onRename, onDelete }: DocRowProps) {
  const { Icon, tone } = iconForMime(doc.mime_type);
  return (
    <div className="flex items-center justify-between gap-4 rounded-[13px] border border-[#eef1f6] bg-[#fafbfd] px-4 py-[14px] transition-colors hover:border-[#dbe2ec] hover:bg-white">
      <div className="flex min-w-0 items-center gap-3.5">
        <span className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-[11px]', tone)}>
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <div className="truncate text-[15px] font-bold text-[#0f172a]">{doc.file_name}</div>
          <div className="mt-1 flex flex-wrap items-center gap-[9px] text-[12.5px] font-medium text-[#94a3b8]">
            <span dir="ltr" className="tabular-nums">{formatDate(doc.created_at)}</span>
            <span className="h-[3px] w-[3px] rounded-full bg-[#cbd5e1]" />
            <span dir="ltr" className="tabular-nums">{formatSize(doc.file_size_bytes)}</span>
            <span className="inline-flex items-center rounded-full bg-[#e8f0ff] px-[9px] py-[3px] text-[11.5px] font-semibold text-[#2563eb]">
              {docTypeLabel(doc.doc_type)}
            </span>
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onView}
          aria-label="צפייה"
          className="inline-flex h-9 items-center gap-1.5 rounded-[9px] px-[13px] text-[13.5px] font-semibold text-[#2563eb] transition-colors hover:bg-[#eff5ff]"
        >
          <Eye className="h-4 w-4" />
          <span className="hidden sm:inline">צפייה</span>
          <Download className="h-3.5 w-3.5 sm:hidden" />
        </button>
        {canEdit && (
          <button
            type="button"
            onClick={onRename}
            aria-label="שנה שם"
            className="grid h-9 w-9 place-items-center rounded-[9px] text-[#64748b] transition-colors hover:bg-[#eef2f7]"
          >
            <Pencil className="h-4 w-4" />
          </button>
        )}
        {canDelete && (
          <button
            type="button"
            onClick={onDelete}
            aria-label="מחק מסמך"
            className="grid h-9 w-9 place-items-center rounded-[9px] text-[#dc2626] transition-colors hover:bg-[#fef2f2]"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}
