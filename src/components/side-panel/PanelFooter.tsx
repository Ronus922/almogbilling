'use client';

import { Clock, FileDown, Printer, Save, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export interface PanelFooterProps {
  onClose: () => void;
  onSave: () => void;
  saveDisabled?: boolean;
  saveLabel?: string;
  /** Optional extra classes merged onto the primary save button (e.g. a
   *  gradient CTA). Additive — callers that omit it keep the flat default. */
  saveClassName?: string;
  /**
   * Optional tooltip text shown when save button is disabled — useful for
   * explaining WHY (e.g., "אין הרשאה — כניסה כצופה"). Wraps the disabled
   * button in a Tooltip; disabled buttons swallow pointer events otherwise.
   */
  saveDisabledReason?: string;
  showPrinter?: boolean;
  showExport?: boolean;
  showHistory?: boolean;
  /** When provided, a destructive "מחק" button is shown on the start side.
   *  Caller is responsible for the confirmation dialog + RBAC gating. */
  onDelete?: () => void;
  deleteLabel?: string;
}

export function PanelFooter({
  onClose,
  onSave,
  saveDisabled = false,
  saveLabel = 'שמור שינויים',
  saveClassName,
  saveDisabledReason,
  showPrinter = false,
  showExport = false,
  showHistory = false,
  onDelete,
  deleteLabel = 'מחק',
}: PanelFooterProps) {
  return (
    <footer className="flex-none border-t border-slate-200 bg-white px-5 py-3">
      <div className="flex items-center justify-between gap-3">
        {/* Right side (start in RTL): סגור + optional delete/printer/export */}
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            סגור
          </Button>
          {onDelete && (
            <Button
              type="button"
              variant="outline"
              onClick={onDelete}
              className="gap-2 border-rose-200 text-rose-600 hover:bg-rose-50 hover:text-rose-700"
            >
              <Trash2 className="h-4 w-4" />
              {deleteLabel}
            </Button>
          )}
          {showPrinter && (
            <Tooltip>
              <TooltipTrigger render={<span className="block" />}>
                <Button type="button" variant="outline" size="icon" disabled aria-label="הדפסה">
                  <Printer className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>בקרוב</TooltipContent>
            </Tooltip>
          )}
          {showExport && (
            <Tooltip>
              <TooltipTrigger render={<span className="block" />}>
                <Button type="button" variant="outline" size="icon" disabled aria-label="ייצוא PDF">
                  <FileDown className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>בקרוב</TooltipContent>
            </Tooltip>
          )}
        </div>

        {/* Left side (end in RTL): optional history + save */}
        <div className="flex items-center gap-2">
          {showHistory && (
            <Tooltip>
              <TooltipTrigger render={<span className="block" />}>
                <Button type="button" variant="outline" disabled className="gap-2">
                  <Clock className="h-4 w-4" />
                  היסטוריה
                </Button>
              </TooltipTrigger>
              <TooltipContent>בקרוב</TooltipContent>
            </Tooltip>
          )}
          {saveDisabled && saveDisabledReason ? (
            <Tooltip>
              <TooltipTrigger render={<span className="block" />}>
                <Button type="button" disabled className="gap-2">
                  <Save className="h-4 w-4" />
                  {saveLabel}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{saveDisabledReason}</TooltipContent>
            </Tooltip>
          ) : (
            <Button
              type="button"
              onClick={onSave}
              disabled={saveDisabled}
              className={cn('gap-2', saveClassName)}
            >
              <Save className="h-4 w-4" />
              {saveLabel}
            </Button>
          )}
        </div>
      </div>
    </footer>
  );
}
