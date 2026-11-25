'use client';

// The parts of the issue window that exist only WITHOUT an order — issuing a
// chip at the reception ("הנפק צ׳יפ", 25/11/2026). The window collects what
// the public order form collects, and nothing here is required of the manager:
//
//   · OrdererForm       — who ordered: full name, mobile phone, email, the
//                         current residential address (street and number,
//                         city, zip);
//   · LeaseField        — a renter block: the lease (a PDF or a photo, the
//                         same bucket and the same access rule as the lease of
//                         a web order), its end date, and "צפייה בחוזה" once
//                         it is there;
//   · ReceptionPayment  — replaces "עמלת הנפקה (₪)" and "החיוב בוצע": the
//                         amount of this save, read only — new chips × the
//                         price per chip of /settings, drawn as the public
//                         page draws its breakdown — and how it is paid.
//                         Nothing is selected by default;
//   · ReceptionRecords  — what an earlier save left: the block's chips say
//                         again who ordered them and how they were settled.
//
// Styles: app/styles/chip-issue-sheet.css ("Reception").

import type { ChangeEvent, ReactNode } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { LEASE_FILE_ACCEPT, formatIlsAfter } from '@/lib/chipOrders/model';
import {
  RECEPTION_CARD_PENDING_TEXT, RECEPTION_PAYMENT_LABEL, receptionAmount,
  type OrdererFields, type ReceptionPaymentMethod, type ReceptionRecordView,
} from '@/lib/chipOrders/reception';
import { e164ToLocal } from '@/lib/portal/phone';
import type { ChipLeaseRef } from '@/lib/types/chips';
import { AlertIco, CheckIco, Ico } from './parts';

const DAY = new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric' });

export const UserIco = () => <Ico><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></Ico>;
const UploadIco = () => <Ico size={15} sw={2}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m17 8-5-5-5 5M12 3v12" /></Ico>;
const CardPayIco = () => <Ico size={16}><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /></Ico>;
const CashIco = () => <Ico size={16}><rect x="2" y="6" width="20" height="12" rx="2" /><circle cx="12" cy="12" r="2.5" /><path d="M6 12h.01M18 12h.01" /></Ico>;
const FreeIco = () => <Ico size={16}><circle cx="12" cy="12" r="10" /><path d="m4.9 4.9 14.2 14.2" /></Ico>;

// ── Who ordered ─────────────────────────────────────────────────────────────

export function OrdererForm({
  value, problems, disabled, onChange,
}: {
  /** What the fields show. Name and phone follow the first chip holder until
   *  the manager types in them — the window decides, this only draws. */
  value: OrdererFields;
  problems: Partial<Record<keyof OrdererFields, string>>;
  disabled: boolean;
  onChange: (field: keyof OrdererFields, v: string) => void;
}) {
  const err = (f: keyof OrdererFields) => (problems[f] ? <span className="ci-err">⚠️ {problems[f]}</span> : null);
  return (
    <div data-testid="chip-reception-orderer">
      <div className="ci-ordrow">
        <div className="ci-fld">
          <label htmlFor="ord-name">שם מלא</label>
          <input id="ord-name" type="text" autoComplete="off" value={value.name} disabled={disabled} placeholder="שם המזמין"
            className={cn(problems.name && 'ci-bad')} onChange={(e) => onChange('name', e.target.value)} />
          {err('name')}
        </div>
        <div className="ci-fld">
          <label htmlFor="ord-phone">טלפון נייד</label>
          <input id="ord-phone" type="tel" inputMode="tel" autoComplete="off" value={value.phone} disabled={disabled} placeholder="052-1234567"
            className={cn('ci-num ci-ltr', problems.phone && 'ci-bad')} onChange={(e) => onChange('phone', e.target.value)} />
          {err('phone')}
        </div>
        <div className="ci-fld">
          <label htmlFor="ord-email">מייל</label>
          <input id="ord-email" type="email" inputMode="email" autoComplete="off" value={value.email} disabled={disabled}
            className={cn('ci-num ci-ltr', problems.email && 'ci-bad')} onChange={(e) => onChange('email', e.target.value)} />
          {err('email')}
        </div>
      </div>
      <div className="ci-addrrow">
        <div className="ci-fld">
          <label htmlFor="ord-street">כתובת מגורים נוכחית (רחוב ומספר בית)</label>
          <input id="ord-street" type="text" autoComplete="off" value={value.street} disabled={disabled} placeholder="לדוגמה: דוד אלעזר 10"
            className={cn(problems.street && 'ci-bad')} onChange={(e) => onChange('street', e.target.value)} />
          {err('street')}
        </div>
        <div className="ci-fld">
          <label htmlFor="ord-city">עיר</label>
          <input id="ord-city" type="text" autoComplete="off" value={value.city} disabled={disabled} placeholder="חיפה"
            className={cn(problems.city && 'ci-bad')} onChange={(e) => onChange('city', e.target.value)} />
          {err('city')}
        </div>
        <div className="ci-fld">
          <label htmlFor="ord-zip">מיקוד</label>
          <input id="ord-zip" type="text" inputMode="numeric" autoComplete="off" maxLength={7} value={value.zip} disabled={disabled} placeholder="7 ספרות"
            className={cn('ci-num ci-ltr', problems.zip && 'ci-bad')} onChange={(e) => onChange('zip', e.target.value.replace(/\D/g, '').slice(0, 7))} />
          {err('zip')}
        </div>
      </div>
    </div>
  );
}

// ── A renter's lease ────────────────────────────────────────────────────────

export function LeaseField({
  idBase, lease, leaseEnd, busy, error, canView, disabled, onPick, onRemove, onLeaseEnd,
}: {
  idBase: string;
  lease: ChipLeaseRef | null;
  /** YYYY-MM-DD, or '' when there is none. */
  leaseEnd: string;
  /** The file is on its way to Storage. */
  busy: boolean;
  error: string | null;
  /** The viewer may open leases (chips_orders_manage:view). */
  canView: boolean;
  disabled: boolean;
  onPick: (file: File) => void;
  onRemove: () => void;
  onLeaseEnd: (v: string) => void;
}) {
  const off = disabled || busy;
  const pick = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // the same file may be picked again after a refusal
    if (file) onPick(file);
  };
  return (
    <div className="ci-leasegrid" data-testid="chip-lease-box">
      <div className="ci-fld">
        <span className="ci-lbl">חוזה שכירות (PDF או תמונה, עד 10MB)</span>
        <div className="ci-leasectl">
          {lease && !busy ? (
            <>
              {canView ? (
                <a href={`/api/files/chip-order-leases/${lease.key}`} target="_blank" rel="noopener noreferrer" data-testid="chip-lease-link">
                  <ExternalLink className="h-4 w-4" />
                  צפייה בחוזה
                </a>
              ) : (
                <span className="ci-leaseok" data-testid="chip-lease-attached"><CheckIco />החוזה צורף</span>
              )}
              <span className="ci-leasename" title={lease.name}>{lease.name}</span>
              <label className={cn('ci-linkbtn', off && 'ci-dis')}>
                החלף
                <input type="file" accept={LEASE_FILE_ACCEPT} disabled={off} onChange={pick} aria-label="החלף את קובץ החוזה" />
              </label>
              <button type="button" className="ci-linkbtn" disabled={off} onClick={onRemove}>הסר</button>
            </>
          ) : (
            <label className={cn('ci-upl', off && 'ci-dis')} data-testid="chip-lease-upload">
              {busy ? <Loader2 className="ci-spin h-4 w-4" /> : <UploadIco />}
              {busy ? 'מעלה…' : 'צרף חוזה'}
              <input type="file" accept={LEASE_FILE_ACCEPT} disabled={off} onChange={pick} aria-label="צרף חוזה שכירות" />
            </label>
          )}
        </div>
        {error && <span className="ci-err" role="alert">⚠️ {error}</span>}
      </div>
      <div className="ci-fld">
        <label htmlFor={`${idBase}-leaseend`}>תאריך סיום חוזה</label>
        <input id={`${idBase}-leaseend`} type="date" className="ci-num" value={leaseEnd} disabled={disabled}
          onChange={(e) => onLeaseEnd(e.target.value)} />
      </div>
    </div>
  );
}

// ── The payment of the new chips ────────────────────────────────────────────

export function ReceptionPayment({
  newChips, unitPrice, method, onMethod, cardOption, disabled, reason,
}: {
  /** NEW chips in this save — the only thing that is paid for. */
  newChips: number;
  /** ₪ per chip from /settings; null = it could not be loaded. */
  unitPrice: number | null;
  method: ReceptionPaymentMethod | null;
  onMethod: (m: ReceptionPaymentMethod) => void;
  /** "אשראי" is drawn — disabled; the server says so for admin / super admin. */
  cardOption: boolean;
  disabled: boolean;
  /** Why the save cannot go yet, as far as the payment goes. */
  reason: string | null;
}) {
  const amount = unitPrice === null ? null : receptionAmount(newChips, unitPrice);
  const free = method === 'none';
  const due = free ? 0 : amount;
  const off = disabled || newChips === 0;
  const option = (m: ReceptionPaymentMethod, icon: ReactNode, sub: ReactNode, testId: string) => (
    <button type="button" role="radio" aria-checked={method === m} className={cn(method === m && 'ci-on')} disabled={off}
      onClick={() => onMethod(m)} data-testid={testId}>
      <span className="ci-payic">{method === m ? <CheckIco /> : icon}</span>
      <span className="ci-paytxt"><b>{RECEPTION_PAYMENT_LABEL[m]}</b><small>{sub}</small></span>
    </button>
  );
  return (
    <div data-testid="chip-reception-payment">
      {newChips > 0 && (
        <div className="ci-brk" data-testid="chip-reception-breakdown">
          <div className="ci-brkh"><span>פריט</span><span className="ci-c">כמות</span><span className="ci-c">מחיר ליחידה</span><span className="ci-t">סה&quot;כ</span></div>
          <div className="ci-brkr">
            <span>כרטיס בקרת כניסה</span>
            <span className="ci-c ci-num">{newChips}</span>
            <span className="ci-c ci-num">{unitPrice === null ? '—' : formatIlsAfter(unitPrice)}</span>
            <span className="ci-t ci-num">{amount === null ? '—' : formatIlsAfter(amount)}</span>
          </div>
        </div>
      )}
      <div className="ci-paytotal">
        <span>
          סה&quot;כ לתשלום
          {newChips === 0 ? <small>אין צ׳יפים חדשים בשמירה הזו</small> : free ? <small>ללא חיוב</small> : null}
        </span>
        <b className="ci-num" data-testid="chip-reception-total">{due === null ? '—' : formatIlsAfter(due)}</b>
      </div>

      <div className="ci-fld ci-payfld">
        <span className="ci-lbl ci-strong" id="pay-method-label">
          אמצעי תשלום{newChips > 0 && <> <span className="ci-req">*</span></>}
        </span>
        <div className={cn('ci-payseg', cardOption && 'ci-three')} role="radiogroup" aria-labelledby="pay-method-label">
          {cardOption && (
            // Not active yet: no clearing is connected. Drawn so the option is
            // known to be coming — never pressed, and no card field anywhere.
            <button type="button" role="radio" aria-checked={false} disabled className="ci-soon" data-testid="chip-pay-card">
              <span className="ci-payic"><CardPayIco /></span>
              <span className="ci-paytxt"><b>{RECEPTION_PAYMENT_LABEL.card}</b><small>{RECEPTION_CARD_PENDING_TEXT}</small></span>
            </button>
          )}
          {option(
            'cash_transfer',
            <CashIco />,
            method === 'cash_transfer' && amount !== null && newChips > 0
              ? <>אישור: התקבלו <span className="ci-num">{formatIlsAfter(amount)}</span></>
              : 'הסכום התקבל במלואו בקבלה',
            'chip-pay-cash',
          )}
          {option('none', <FreeIco />, 'אורח, צוות או החלפה', 'chip-pay-none')}
        </div>
        {newChips === 0 ? (
          <p className="ci-payhint">אמצעי תשלום נבחר רק כשמנפיקים צ׳יפים חדשים. עריכת צ׳יפים קיימים אינה דורשת תשלום.</p>
        ) : reason && (
          <p className="ci-reason ci-flat" role="status" data-testid="chip-reception-reason">
            <AlertIco size={13} />
            <span>{reason}</span>
          </p>
        )}
      </div>
    </div>
  );
}

// ── What an earlier save left on a block ────────────────────────────────────

const phoneView = (p: string | null) => (p ? e164ToLocal(p) : '');

/** The reception saves a block's chips came from: when, how they were settled,
 *  and the orderer details that were stored with them. Read only. */
export function ReceptionRecords({ records }: { records: ReceptionRecordView[] }) {
  if (records.length === 0) return null;
  return (
    <div className="ci-recs" data-testid="chip-reception-records">
      {records.map((r) => {
        const who = [r.orderer_name, phoneView(r.orderer_phone), r.orderer_email, r.address].filter(Boolean) as string[];
        return (
          <div key={r.ref} className="ci-rec">
            <div className="ci-rechead">
              <b>
                {r.kind === 'order' ? <>הזמנת קבלה <span className="ci-num">{r.order_number}</span></> : 'הנפקה בקבלה'}
              </b>
              <span className="ci-num">{DAY.format(new Date(r.created_at))}</span>
              <span className={cn('ci-tag', r.kind === 'order' ? 'ci-green' : 'ci-grey')}>
                {r.kind === 'order'
                  ? <>שולם <span className="ci-num">{formatIlsAfter(r.amount)}</span> · {RECEPTION_PAYMENT_LABEL.cash_transfer}</>
                  : RECEPTION_PAYMENT_LABEL.none}
              </span>
              <span className="ci-recqty"><span className="ci-num">{r.chips_count}</span> {r.chips_count === 1 ? 'צ׳יפ' : 'צ׳יפים'}</span>
            </div>
            <p>
              <span>מזמין: </span>
              {who.length === 0
                ? 'לא נרשמו פרטים'
                : who.map((v, i) => (
                    <span key={i}>
                      {i > 0 && ' · '}
                      {/* The name and the address read right to left; a phone and an email stay left to right. */}
                      {v === r.orderer_name || v === r.address ? v : <span className="ci-num">{v}</span>}
                    </span>
                  ))}
              {r.by_name && <span className="ci-recby"> · נרשם ע״י {r.by_name}</span>}
            </p>
          </div>
        );
      })}
    </div>
  );
}
