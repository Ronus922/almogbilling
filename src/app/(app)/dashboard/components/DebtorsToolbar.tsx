'use client';

import { useState, useEffect, useTransition } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { Search, Printer, FileDown, FileText } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export function DebtorsToolbar({ totalRows }: { totalRows: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const [apt, setApt] = useState(searchParams.get('apt') ?? '');
  const [q, setQ] = useState(searchParams.get('q') ?? '');

  // Debounced sync to URL
  useEffect(() => {
    const t = setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString());
      if (apt) params.set('apt', apt); else params.delete('apt');
      if (q)   params.set('q', q);     else params.delete('q');
      params.delete('page');
      const qs = params.toString();
      startTransition(() => {
        router.push(qs ? `${pathname}?${qs}` : pathname);
      });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apt, q]);

  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
      <div className="flex items-baseline gap-3">
        <h2 className="text-[16px] font-bold text-ink">טבלת חייבים</h2>
        <span className="text-sm text-ink-2">
          סה״כ <span className="font-num tabular-nums">{totalRows}</span> רשומות
        </span>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative">
          <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
          <Input
            placeholder="מספר דירה..."
            value={apt}
            onChange={(e) => setApt(e.target.value)}
            className="h-[34px] w-40 rounded-lg border-line bg-surface-2 pe-9"
          />
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
          <Input
            placeholder="שם בעלים..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-[34px] w-48 rounded-lg border-line bg-surface-2 pe-9"
          />
        </div>
        <Select disabled defaultValue="all">
          <SelectTrigger className="h-[34px] w-40 rounded-lg border-line bg-surface-2">
            <SelectValue placeholder="כל המצבים" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">כל המצבים</SelectItem>
          </SelectContent>
        </Select>
        <span className="mx-0.5 h-6 w-px bg-line" aria-hidden />
        <Tooltip>
          <TooltipTrigger render={<span />}>
              <Button type="button" variant="outline" size="icon" disabled aria-label="הדפסה" className="h-[34px] w-[34px] rounded-lg border-line bg-surface-2 text-ink-2">
                <Printer className="h-4 w-4" />
              </Button>
          </TooltipTrigger>
          <TooltipContent>בקרוב</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<span />}>
              <Button type="button" variant="outline" size="icon" disabled aria-label="ייצוא PDF" className="h-[34px] w-[34px] rounded-lg border-line bg-surface-2 text-ink-2">
                <FileText className="h-4 w-4" />
              </Button>
          </TooltipTrigger>
          <TooltipContent>בקרוב</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<span />}>
              <Button type="button" variant="outline" size="icon" disabled aria-label="ייצוא Excel" className="h-[34px] w-[34px] rounded-lg border-line bg-surface-2 text-ink-2">
                <FileDown className="h-4 w-4" />
              </Button>
          </TooltipTrigger>
          <TooltipContent>בקרוב</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
