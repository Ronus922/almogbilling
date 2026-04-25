'use client';

import { Clock, FileDown, Printer, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface Props {
  isAdmin: boolean;
  isDirty: boolean;
  isSaving: boolean;
  onClose: () => void;
  onSave: () => void;
}

export function PanelFooter({ isAdmin, isDirty, isSaving, onClose, onSave }: Props) {
  const saveDisabled = !isAdmin || !isDirty || isSaving;

  return (
    <footer className="flex-none border-t border-slate-200 bg-white px-5 py-3">
      <div className="flex items-center justify-between gap-3">
        {/* Right side (start in RTL): סגור + printer + pdf */}
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            סגור
          </Button>
          <Tooltip>
            <TooltipTrigger render={<span className="block" />}>
              <Button type="button" variant="outline" size="icon" disabled aria-label="הדפסה">
                <Printer className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>בקרוב</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<span className="block" />}>
              <Button type="button" variant="outline" size="icon" disabled aria-label="ייצוא PDF">
                <FileDown className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>בקרוב</TooltipContent>
          </Tooltip>
        </div>

        {/* Left side (end in RTL): history + save */}
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger render={<span className="block" />}>
              <Button type="button" variant="outline" disabled className="gap-2">
                <Clock className="h-4 w-4" />
                היסטוריה
              </Button>
            </TooltipTrigger>
            <TooltipContent>בקרוב</TooltipContent>
          </Tooltip>
          {!isAdmin ? (
            <Tooltip>
              <TooltipTrigger render={<span className="block" />}>
                <Button type="button" disabled className="gap-2 bg-blue-600 text-white">
                  <Save className="h-4 w-4" />
                  שמור שינויים
                </Button>
              </TooltipTrigger>
              <TooltipContent>אין הרשאה — כניסה כצופה</TooltipContent>
            </Tooltip>
          ) : (
            <Button
              type="button"
              onClick={onSave}
              disabled={saveDisabled}
              className="gap-2 bg-blue-600 text-white hover:bg-blue-700"
            >
              <Save className="h-4 w-4" />
              {isSaving ? 'שומר…' : 'שמור שינויים'}
            </Button>
          )}
        </div>
      </div>
    </footer>
  );
}
