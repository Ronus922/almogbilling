'use client';

import { Clock, FileDown, Printer, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export interface PanelFooterProps {
  onClose: () => void;
  onSave: () => void;
  saveDisabled?: boolean;
  saveLabel?: string;
  /**
   * Optional tooltip text shown when save button is disabled — useful for
   * explaining WHY (e.g., "אין הרשאה — כניסה כצופה"). Wraps the disabled
   * button in a Tooltip; disabled buttons swallow pointer events otherwise.
   */
  saveDisabledReason?: string;
  showPrinter?: boolean;
  showExport?: boolean;
  showHistory?: boolean;
}

export function PanelFooter({
  onClose,
  onSave,
  saveDisabled = false,
  saveLabel = 'שמור שינויים',
  saveDisabledReason,
  showPrinter = false,
  showExport = false,
  showHistory = false,
}: PanelFooterProps) {
  return (
    <footer className="flex-none border-t border-slate-200 bg-white px-5 py-3">
      <div className="flex items-center justify-between gap-3">
        {/* Right side (start in RTL): סגור + optional printer/export */}
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            סגור
          </Button>
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
                <Button type="button" disabled className="gap-2 bg-blue-600 text-white">
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
              className="gap-2 bg-blue-600 text-white hover:bg-blue-700"
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
