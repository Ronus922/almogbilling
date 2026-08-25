'use client';

import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { AssetCell, type CellItem, type CellSaveResult } from '@/components/parking/asset-cell';

// The whole /parking screen is this table: one row per apartment, then חוף
// הכרמל and נציגות at the bottom, and one cell each for the parking numbers and
// the storage numbers. Nothing is summarised, counted or filtered into tabs —
// the allocation of the building is the screen.

export type AssetRowKind = 'apartment' | 'developer' | 'committee';

export interface AssetTableRow {
  key: string;
  /** Apartment number, or the name of the entity that holds the row. */
  label: string;
  kind: AssetRowKind;
  /** חוף הכרמל and נציגות are read-only: a number reaches them by being removed
   *  from an apartment, and leaves by being given to one. There is nowhere
   *  lower to release it to. */
  editable: boolean;
  parking: CellItem[];
  storage: CellItem[];
}

export type EditingCell = { rowKey: string; kind: 'parking' | 'storage' } | null;

export function AssetsTable({
  rows,
  editing,
  onOpen,
  onClose,
  onSave,
}: {
  rows: AssetTableRow[];
  editing: EditingCell;
  onOpen: (rowKey: string, kind: 'parking' | 'storage') => void;
  onClose: (rowKey: string) => void;
  onSave: (
    row: AssetTableRow, kind: 'parking' | 'storage', draft: CellItem[], approved: Set<string>,
  ) => Promise<CellSaveResult>;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-12 text-center text-sm text-muted-foreground">
        לא נמצאה דירה, חניה או מחסן בחיפוש הזה.
      </div>
    );
  }

  const firstEntityKey = rows.find((r) => r.kind !== 'apartment')?.key;

  return (
    <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
      <Table>
        <TableHeader className="[&_tr]:border-b [&_tr]:border-slate-200">
          <TableRow className="bg-slate-50 hover:bg-slate-50">
            <TableHead className="h-11 w-28 px-4 text-start text-sm font-semibold text-slate-500">דירה</TableHead>
            <TableHead className="h-11 px-4 text-start text-sm font-semibold text-slate-500">חניות</TableHead>
            <TableHead className="h-11 px-4 text-start text-sm font-semibold text-slate-500">מחסנים</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow
              key={row.key}
              className={cn(
                'border-b border-slate-100 h-12 hover:bg-slate-50',
                row.kind !== 'apartment' && 'bg-slate-50/60',
                row.key === firstEntityKey && 'border-t-2 border-t-slate-200',
              )}
            >
              <TableCell
                className={cn(
                  'px-4 py-3 text-start text-sm',
                  row.kind === 'apartment'
                    ? 'font-bold text-slate-900 tabular-nums'
                    : 'font-semibold text-slate-600',
                )}
              >
                {row.label}
              </TableCell>
              {(['parking', 'storage'] as const).map((kind) => (
                <TableCell key={kind} className="px-4 py-3 align-middle">
                  <AssetCell
                    kind={kind}
                    items={row[kind]}
                    editable={row.editable}
                    editing={editing?.rowKey === row.key && editing.kind === kind}
                    onOpen={() => onOpen(row.key, kind)}
                    onClose={() => onClose(row.key)}
                    onSave={(draft, approved) => onSave(row, kind, draft, approved)}
                  />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
