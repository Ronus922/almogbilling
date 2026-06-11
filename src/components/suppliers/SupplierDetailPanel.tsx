'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  X, Building2, MapPin, CreditCard, FileText, Activity, Phone, Mail, Globe,
  User as UserIcon, StickyNote, Pencil, Power, PowerOff, Archive, Trash2,
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
import { Section } from '@/components/side-panel/Section';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { cn } from '@/lib/utils';
import { validatePhone } from '@/lib/validation';
import { formatPhoneDisplay } from '@/lib/phone';
import {
  SUPPLIER_TYPES, supplierTypeMeta, supplierStatusMeta,
  PAYMENT_TERMS, paymentTermsLabel,
  DOC_TYPES, docTypeLabel, ALLOWED_DOC_TYPES, MAX_DOC_SIZE_BYTES,
} from '@/lib/constants/suppliers';
import type {
  Supplier, SupplierDocument, SupplierWritableFields,
  SupplierStatus, SupplierPaymentTerms, SupplierDocType,
} from '@/lib/types/suppliers';

interface Props {
  supplierId: string | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onChanged: () => void;
  canEdit: boolean;
  canDelete: boolean;
}

const STATUS_TONE: Record<SupplierStatus, string> = {
  active: 'bg-emerald-100 text-emerald-700',
  inactive: 'bg-slate-100 text-slate-600',
  archived: 'bg-amber-100 text-amber-700',
};

type FormState = SupplierWritableFields;

function toForm(s: Supplier): FormState {
  return {
    display_name: s.display_name,
    company_name: s.company_name,
    contact_person: s.contact_person,
    supplier_type: s.supplier_type,
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
  supplierId, open, onOpenChange, onChanged, canEdit, canDelete,
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
  const [uploading, setUploading] = useState(false);

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

  useEscapeKey(open && !confirmCloseOpen && !confirmDeleteOpen && confirmDeleteDocId === null, () => requestClose());
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
      const r = await fetch(`/api/suppliers/${supplierId}/documents`, {
        method: 'POST',
        credentials: 'include',
        body: fd,
      });
      const data = (await r.json().catch(() => ({}))) as { document?: SupplierDocument; error?: string };
      if (!r.ok || !data.document) throw new Error(data.error ?? 'העלאה נכשלה');
      setDocuments((prev) => [data.document as SupplierDocument, ...prev]);
      setUploadFile(null);
      setUploadDocType('general');
      toast.success('המסמך הועלה');
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
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setConfirmDeleteDocId(null);
    }
  }

  const statusMeta = supplier ? supplierStatusMeta(supplier.status) : null;
  const typeMeta = supplier ? supplierTypeMeta(supplier.supplier_type) : null;
  const TypeIcon = typeMeta?.icon ?? Building2;

  return (
    <>
      <Sheet open={open} onOpenChange={(o) => { if (!o) requestClose(); else onOpenChange(o); }}>
        <SheetContent
          side="left"
          dir="rtl"
          showCloseButton={false}
          className="w-full p-0 sm:w-[55vw] md:min-w-[720px] flex flex-col gap-0 overflow-hidden bg-white"
        >
          {/* Header */}
          <SheetHeader className="flex-none gap-2 bg-gradient-to-bl from-slate-900 via-blue-950 to-blue-900 px-6 py-6 text-white">
            {loading ? (
              <div className="space-y-2">
                <div className="h-8 w-56 rounded bg-white/10 animate-pulse" />
                <div className="h-4 w-72 rounded bg-white/10 animate-pulse" />
              </div>
            ) : supplier && statusMeta ? (
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <SheetTitle className="text-2xl font-bold text-white">
                      {supplier.display_name}
                    </SheetTitle>
                    <span className={cn(
                      'inline-flex items-center rounded-full px-3 py-0.5 text-xs font-semibold',
                      STATUS_TONE[supplier.status],
                    )}>
                      {statusMeta.label}
                    </span>
                  </div>
                  <p className="mt-1 inline-flex items-center gap-1.5 text-sm text-white/70">
                    <TypeIcon className="h-3.5 w-3.5" />
                    {typeMeta?.label}
                    {supplier.company_name && (
                      <>
                        <span className="mx-1 text-white/40">•</span>
                        {supplier.company_name}
                      </>
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={requestClose}
                  aria-label="סגור"
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/25 bg-white/5 text-white transition-colors hover:bg-white/15 hover:border-white/50"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            ) : null}
          </SheetHeader>

          {/* Body */}
          <div className="flex-1 overflow-y-auto bg-slate-50/60 p-5">
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
                <TabsList className="grid w-full grid-cols-3">
                  <TabsTrigger value="details" className="gap-2">
                    <Building2 className="h-4 w-4" /> פרטים
                  </TabsTrigger>
                  <TabsTrigger value="documents" className="gap-2">
                    <FileText className="h-4 w-4" /> מסמכים
                  </TabsTrigger>
                  <TabsTrigger value="activity" className="gap-2">
                    <Activity className="h-4 w-4" /> פעילות
                  </TabsTrigger>
                </TabsList>

                {/* TAB — פרטים */}
                <TabsContent value="details" className="mt-5 space-y-4">
                  {editing && form ? (
                    <EditForm
                      form={form}
                      set={set}
                      markTouched={markTouched}
                      errFor={errFor}
                      disabled={saving}
                    />
                  ) : (
                    <ViewDetails
                      supplier={supplier}
                      canEdit={canEdit}
                      saving={saving}
                      onEdit={startEdit}
                      onStatusChange={handleStatusChange}
                    />
                  )}
                </TabsContent>

                {/* TAB — מסמכים */}
                <TabsContent value="documents" className="mt-5 space-y-4">
                  {canEdit && (
                    <Section title="העלאת מסמך" icon={Upload} iconTone="blue">
                      <div className="space-y-3 py-2">
                        <div className="space-y-2">
                          <Label className="text-base font-medium text-muted-foreground">סוג מסמך</Label>
                          <Select
                            value={uploadDocType}
                            onValueChange={(v) => { if (v) setUploadDocType(v as SupplierDocType); }}
                            disabled={uploading}
                          >
                            <SelectTrigger className="w-full data-[size=default]:h-10">
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
                        <div className="space-y-2">
                          <Label htmlFor="sup-doc-file" className="text-base font-medium text-muted-foreground">קובץ</Label>
                          <Input
                            id="sup-doc-file"
                            type="file"
                            disabled={uploading}
                            accept={ALLOWED_DOC_TYPES.join(',')}
                            onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)}
                            className="h-10 pt-1.5"
                          />
                          <p className="text-xs text-slate-500">
                            עד 10MB. תמונות, PDF, Word או Excel.
                          </p>
                        </div>
                        <Button
                          type="button"
                          onClick={handleUpload}
                          disabled={!uploadFile || uploading}
                          className="gap-2 bg-blue-600 text-white hover:bg-blue-700"
                        >
                          <Upload className="h-4 w-4" />
                          {uploading ? 'מעלה…' : 'העלה מסמך'}
                        </Button>
                      </div>
                    </Section>
                  )}

                  <Section title="מסמכים" icon={FileText} iconTone="slate">
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
                            canDelete={canDelete}
                            onView={() => handleViewDocument(doc.id)}
                            onDelete={() => setConfirmDeleteDocId(doc.id)}
                          />
                        ))}
                      </div>
                    )}
                  </Section>
                </TabsContent>

                {/* TAB — פעילות */}
                <TabsContent value="activity" className="mt-5">
                  <div className="rounded-xl bg-white p-12 text-center ring-1 ring-slate-200/70">
                    <Activity className="mx-auto h-8 w-8 text-slate-300" />
                    <p className="mt-3 text-sm text-muted-foreground">
                      יומן פעילות יתווסף בהמשך
                    </p>
                  </div>
                </TabsContent>
              </Tabs>
            )}
          </div>

          {/* Footer — only in edit mode */}
          {!loading && supplier && editing && (
            <footer className="flex-none border-t border-slate-200 bg-white px-5 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  {canDelete && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setConfirmDeleteOpen(true)}
                      disabled={saving}
                      className="gap-2 border-red-200 text-red-600 hover:bg-red-50"
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
                    className="gap-2 bg-blue-600 text-white hover:bg-blue-700"
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
    </>
  );
}

/* ---------- View mode ---------- */

interface ViewProps {
  supplier: Supplier;
  canEdit: boolean;
  saving: boolean;
  onEdit: () => void;
  onStatusChange: (next: SupplierStatus) => void;
}

function ViewDetails({ supplier, canEdit, saving, onEdit, onStatusChange }: ViewProps) {
  return (
    <>
      {/* Status / edit action buttons by current status */}
      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={onEdit}
            disabled={saving}
            className="gap-2"
          >
            <Pencil className="h-4 w-4" /> ערוך
          </Button>
          {supplier.status === 'active' && (
            <Button
              type="button"
              variant="outline"
              onClick={() => onStatusChange('inactive')}
              disabled={saving}
              className="gap-2 border-slate-200 text-slate-600 hover:bg-slate-50"
            >
              <PowerOff className="h-4 w-4" /> השבת
            </Button>
          )}
          {supplier.status === 'inactive' && (
            <Button
              type="button"
              variant="outline"
              onClick={() => onStatusChange('active')}
              disabled={saving}
              className="gap-2 border-emerald-200 text-emerald-700 hover:bg-emerald-50"
            >
              <Power className="h-4 w-4" /> הפעל
            </Button>
          )}
          {supplier.status !== 'archived' && (
            <Button
              type="button"
              variant="outline"
              onClick={() => onStatusChange('archived')}
              disabled={saving}
              className="gap-2 border-amber-200 text-amber-700 hover:bg-amber-50"
            >
              <Archive className="h-4 w-4" /> העבר לארכיון
            </Button>
          )}
          {supplier.status === 'archived' && (
            <Button
              type="button"
              variant="outline"
              onClick={() => onStatusChange('active')}
              disabled={saving}
              className="gap-2 border-emerald-200 text-emerald-700 hover:bg-emerald-50"
            >
              <Power className="h-4 w-4" /> שחזר מארכיון
            </Button>
          )}
        </div>
      )}

      {/* פרטי קשר */}
      <Section title="פרטי קשר" icon={Phone} iconTone="blue">
        <dl className="space-y-2.5 py-2">
          <InfoRow icon={UserIcon} label="איש קשר" value={supplier.contact_person} />
          <InfoRow
            icon={Phone}
            label="טלפון"
            value={formatPhoneDisplay(supplier.phone)}
            ltr
          />
          <InfoRow
            icon={Phone}
            label="נייד"
            value={formatPhoneDisplay(supplier.mobile)}
            ltr
          />
          <InfoRow icon={Mail} label="אימייל" value={supplier.email || null} ltr />
          <InfoRow icon={Globe} label="אתר" value={supplier.website || null} ltr />
        </dl>
      </Section>

      {/* כתובת */}
      <Section title="כתובת" icon={MapPin} iconTone="slate">
        <dl className="space-y-2.5 py-2">
          <InfoRow icon={MapPin} label="כתובת" value={supplier.address || null} />
          <InfoRow icon={MapPin} label="עיר" value={supplier.city || null} />
          <InfoRow icon={FileText} label="ח.פ / עוסק" value={supplier.tax_id || null} ltr />
        </dl>
      </Section>

      {/* תנאי תשלום */}
      <Section title="תנאי תשלום" icon={CreditCard} iconTone="emerald">
        <dl className="space-y-2.5 py-2">
          <InfoRow icon={CreditCard} label="תנאי תשלום" value={paymentTermsLabel(supplier.payment_terms)} />
          <InfoRow icon={Building2} label="בנק" value={supplier.bank_name || null} />
          <InfoRow icon={Building2} label="סניף" value={supplier.bank_branch || null} ltr />
          <InfoRow icon={CreditCard} label="מספר חשבון" value={supplier.bank_account || null} ltr />
        </dl>
      </Section>

      {/* הערות */}
      {supplier.notes && (
        <Section title="הערות" icon={StickyNote} iconTone="slate">
          <p className="whitespace-pre-wrap py-2 text-sm text-slate-700">{supplier.notes}</p>
        </Section>
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

interface InfoRowProps {
  icon: typeof Phone;
  label: string;
  value: string | null;
  ltr?: boolean;
}

function InfoRow({ icon: Icon, label, value, ltr }: InfoRowProps) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
        <Icon className="h-3.5 w-3.5 text-slate-400" />
        {label}
      </dt>
      <dd
        dir={ltr ? 'ltr' : undefined}
        className={cn('text-sm font-medium text-slate-800', ltr && 'tabular-nums')}
      >
        {value ?? '—'}
      </dd>
    </div>
  );
}

/* ---------- Edit mode (same 3 sections as create + internal_notes) ---------- */

interface EditFormProps {
  form: FormState;
  set: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
  markTouched: (key: keyof FormState) => void;
  errFor: (key: keyof FormState) => string | null;
  disabled: boolean;
}

function EditForm({ form, set, markTouched, errFor, disabled }: EditFormProps) {
  return (
    <>
      {/* Section 1 — פרטי הספק */}
      <Section title="פרטי הספק" icon={Building2} iconTone="blue">
        <div className="space-y-4 py-2">
          <EditField
            id="esup-display-name" label="שם תצוגה" required
            value={form.display_name} onChange={(v) => set('display_name', v)}
            onBlur={() => markTouched('display_name')} error={errFor('display_name')} disabled={disabled}
          />
          <EditField
            id="esup-company-name" label="שם החברה"
            value={form.company_name} onChange={(v) => set('company_name', v)} disabled={disabled}
          />
          <div className="space-y-2">
            <Label className="text-base font-medium text-muted-foreground">סוג ספק</Label>
            <Select
              value={form.supplier_type}
              onValueChange={(v) => { if (v) set('supplier_type', v); }}
              disabled={disabled}
            >
              <SelectTrigger className="w-full data-[size=default]:h-10">
                <SelectValue placeholder="בחר סוג...">
                  {(value: string | null) => {
                    if (!value) return null;
                    const meta = supplierTypeMeta(value);
                    const Icon = meta.icon;
                    return (
                      <span className="inline-flex items-center gap-2">
                        <Icon className="h-4 w-4 text-slate-500" />
                        {meta.label}
                      </span>
                    );
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {SUPPLIER_TYPES.map((t) => {
                  const Icon = t.icon;
                  return (
                    <SelectItem key={t.value} value={t.value}>
                      <span className="inline-flex items-center gap-2">
                        <Icon className="h-4 w-4 text-slate-500" />
                        {t.label}
                      </span>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
          <EditField
            id="esup-contact-person" label="איש קשר"
            value={form.contact_person} onChange={(v) => set('contact_person', v)} disabled={disabled}
          />
          <EditField
            id="esup-phone" label="טלפון"
            value={form.phone} onChange={(v) => set('phone', v)}
            onBlur={() => markTouched('phone')} error={errFor('phone')} disabled={disabled}
            inputMode="tel" dir="ltr" tabularNums placeholder="03-1234567"
          />
          <EditField
            id="esup-mobile" label="נייד"
            value={form.mobile} onChange={(v) => set('mobile', v)}
            onBlur={() => markTouched('mobile')} error={errFor('mobile')} disabled={disabled}
            inputMode="tel" dir="ltr" tabularNums placeholder="052-1234567"
          />
          <EditField
            id="esup-email" label="אימייל" type="email"
            value={form.email} onChange={(v) => set('email', v)} disabled={disabled}
            dir="ltr" placeholder="supplier@example.com"
          />
        </div>
      </Section>

      {/* Section 2 — כתובת ופרטים נוספים */}
      <Section title="כתובת ופרטים נוספים" icon={MapPin} iconTone="slate">
        <div className="space-y-4 py-2">
          <EditField id="esup-address" label="כתובת" value={form.address} onChange={(v) => set('address', v)} disabled={disabled} />
          <EditField id="esup-city" label="עיר" value={form.city} onChange={(v) => set('city', v)} disabled={disabled} />
          <EditField id="esup-website" label="אתר אינטרנט" value={form.website} onChange={(v) => set('website', v)} disabled={disabled} dir="ltr" placeholder="https://" />
          <EditField id="esup-tax-id" label="ח.פ / עוסק מורשה" value={form.tax_id} onChange={(v) => set('tax_id', v)} disabled={disabled} dir="ltr" tabularNums />
          <div className="space-y-2">
            <Label htmlFor="esup-notes" className="text-base font-medium text-muted-foreground">הערות</Label>
            <Textarea
              id="esup-notes"
              value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
              disabled={disabled}
              className="min-h-24"
            />
          </div>
        </div>
      </Section>

      {/* Section 3 — תנאי תשלום */}
      <Section title="תנאי תשלום" icon={CreditCard} iconTone="emerald">
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label className="text-base font-medium text-muted-foreground">תנאי תשלום</Label>
            <Select
              value={form.payment_terms}
              onValueChange={(v) => { if (v) set('payment_terms', v as SupplierPaymentTerms); }}
              disabled={disabled}
            >
              <SelectTrigger className="w-full data-[size=default]:h-10">
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
          <EditField id="esup-bank-name" label="שם הבנק" value={form.bank_name} onChange={(v) => set('bank_name', v)} disabled={disabled} />
          <EditField id="esup-bank-branch" label="סניף" value={form.bank_branch} onChange={(v) => set('bank_branch', v)} disabled={disabled} dir="ltr" tabularNums />
          <EditField id="esup-bank-account" label="מספר חשבון" value={form.bank_account} onChange={(v) => set('bank_account', v)} disabled={disabled} dir="ltr" tabularNums />
        </div>
      </Section>

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

interface EditFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  error?: string | null;
  required?: boolean;
  disabled?: boolean;
  type?: string;
  dir?: 'ltr' | 'rtl';
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
  tabularNums?: boolean;
  placeholder?: string;
}

function EditField({
  id, label, value, onChange, onBlur, error, required, disabled,
  type, dir, inputMode, tabularNums, placeholder,
}: EditFieldProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-base font-medium text-muted-foreground">
        {label}
        {required && <span className="text-red-500"> *</span>}
      </Label>
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        disabled={disabled}
        dir={dir}
        inputMode={inputMode}
        placeholder={placeholder}
        className={cn(
          'h-10',
          tabularNums && 'tabular-nums',
          error && 'border-red-400 bg-red-50 focus-visible:ring-red-200',
        )}
      />
      {error && (
        <p className="text-[12px] font-semibold text-red-500 text-right">
          ⚠️ {error}
        </p>
      )}
    </div>
  );
}

/* ---------- Document row ---------- */

interface DocRowProps {
  doc: SupplierDocument;
  canDelete: boolean;
  onView: () => void;
  onDelete: () => void;
}

function iconForMime(mime: string): typeof FileIcon {
  if (mime.startsWith('image/')) return ImageIcon;
  if (mime.includes('spreadsheet') || mime.includes('excel')) return FileSpreadsheet;
  if (mime === 'application/pdf') return FileText;
  return FileIcon;
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

function DocumentRow({ doc, canDelete, onView, onDelete }: DocRowProps) {
  const Icon = iconForMime(doc.mime_type);
  return (
    <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-3">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-500">
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-slate-800">{doc.file_name}</div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-500">
          <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600">
            {docTypeLabel(doc.doc_type)}
          </span>
          <span dir="ltr" className="tabular-nums">{formatSize(doc.file_size_bytes)}</span>
          <span className="text-slate-300">•</span>
          <span dir="ltr" className="tabular-nums">{formatDate(doc.created_at)}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onView}
          aria-label="צפייה"
          className="inline-flex items-center gap-1 rounded p-1.5 text-sm text-blue-600 transition-colors hover:bg-blue-50 hover:text-blue-700"
        >
          <Eye className="h-4 w-4" />
          <span className="hidden sm:inline">צפייה</span>
          <Download className="h-3.5 w-3.5 sm:hidden" />
        </button>
        {canDelete && (
          <button
            type="button"
            onClick={onDelete}
            aria-label="מחק מסמך"
            className="rounded p-1.5 text-rose-500 transition-colors hover:bg-rose-50 hover:text-rose-600"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}
