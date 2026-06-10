'use client';

import type { ReactNode } from 'react';
import { Search, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface Props {
  totalCount: number;
  search: string;
  onSearchChange: (v: string) => void;
  onCreate: () => void;
  /** Tabs row rendered between the header and search input. */
  children?: ReactNode;
}

export function UsersToolbar({
  totalCount,
  search,
  onSearchChange,
  onCreate,
  children,
}: Props) {
  return (
    <div className="space-y-3">
      {/* Row 1 — title + count + create button */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold">ניהול משתמשים</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {totalCount} משתמשים
          </p>
        </div>
        <Button
          type="button"
          onClick={onCreate}
          className="h-9 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold gap-2"
        >
          <UserPlus className="h-4 w-4" />
          צור משתמש
        </Button>
      </div>

      {/* Row 2 — tabs (slot) */}
      {children}

      {/* Row 3 — search */}
      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="חיפוש לפי שם או אימייל"
          className="h-10 pe-9"
        />
      </div>
    </div>
  );
}
