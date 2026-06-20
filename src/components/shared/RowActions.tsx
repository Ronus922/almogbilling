'use client';

// Shared per-row edit + delete actions (table rows). The delete button only
// renders when onDelete is provided, so callers gate it by RBAC. Both buttons
// stop propagation so they don't trigger the row's own onClick.

import { Pencil, Trash2 } from 'lucide-react';

export function RowActions({
  onEdit,
  onDelete,
}: {
  onEdit: () => void;
  onDelete?: () => void;
}) {
  return (
    <div className="flex items-center justify-center gap-1">
      <button
        type="button"
        aria-label="ערוך"
        onClick={(e) => { e.stopPropagation(); onEdit(); }}
        className="grid h-8 w-8 place-items-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
      >
        <Pencil className="h-4 w-4" />
      </button>
      {onDelete && (
        <button
          type="button"
          aria-label="מחק"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="grid h-8 w-8 place-items-center rounded-md text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-600"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
