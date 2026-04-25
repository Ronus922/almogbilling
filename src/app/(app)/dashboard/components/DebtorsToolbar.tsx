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
        <h2 className="text-xl font-bold text-slate-800">טבלת חייבים</h2>
        <span className="text-sm text-slate-400">סה״כ {totalRows} רשומות</span>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative">
          <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="מספר דירה..."
            value={apt}
            onChange={(e) => setApt(e.target.value)}
            className="pe-9 w-40"
          />
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="שם בעלים..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="pe-9 w-48"
          />
        </div>
        <Select disabled defaultValue="all">
          <SelectTrigger className="w-40">
            <SelectValue placeholder="כל המצבים" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">כל המצבים</SelectItem>
          </SelectContent>
        </Select>
        <Tooltip>
          <TooltipTrigger render={<span />}>
              <Button type="button" variant="outline" size="icon" disabled aria-label="הדפסה">
                <Printer className="h-4 w-4" />
              </Button>
          </TooltipTrigger>
          <TooltipContent>בקרוב</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<span />}>
              <Button type="button" variant="outline" size="icon" disabled aria-label="ייצוא PDF">
                <FileText className="h-4 w-4" />
              </Button>
          </TooltipTrigger>
          <TooltipContent>בקרוב</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<span />}>
              <Button type="button" variant="outline" size="icon" disabled aria-label="ייצוא Excel">
                <FileDown className="h-4 w-4" />
              </Button>
          </TooltipTrigger>
          <TooltipContent>בקרוב</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
