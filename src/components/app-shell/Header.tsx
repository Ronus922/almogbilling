'use client';

import { useState } from 'react';
import Link from 'next/link';
import { MessageCircle, MessagesSquare, ChevronDown, LogOut, type LucideIcon } from 'lucide-react';
import { NotificationBell } from './NotificationBell';
import { GlobalSearch } from './GlobalSearch';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAuth, usePermissions } from '@/lib/auth/context';
import { ROLE_STYLES, roleLabel } from '@/lib/permissions/constants';
import { cn } from '@/lib/utils';

export function Header() {
  const { user } = useAuth();
  const { can } = usePermissions();

  // Notifications (bell) are hidden from the read-only `viewer`, who is scoped to
  // the debtors screen only — same boundary enforced on /notifications and the
  // /api/notifications/* routes. Gating here (not inside NotificationBell) keeps
  // the bell from ever mounting/polling for a viewer. The chat / WhatsApp quick
  // links reuse the same per-module RBAC as their sidebar entries (no new gate).
  const showNotifications = user.role !== 'viewer';
  const showChat = can('internal_chat', 'view');
  const showWhatsapp = can('whatsapp_chat', 'view');
  const hasIcons = showNotifications || showChat || showWhatsapp;

  return (
    <header className="flex h-16 shrink-0 items-center gap-4 border-b border-line bg-white/90 px-6 backdrop-blur">
      {/* Right (RTL start): global search — opens the ⌘K command palette. */}
      <div className="flex w-full max-w-[440px] items-center">
        <GlobalSearch />
      </div>

      <div className="flex-1" />

      {/* Left (RTL end): notification/chat/whatsapp icons + user pill */}
      <div className="flex items-center gap-2.5">
        {showNotifications && <NotificationBell />}
        {showChat && <HeaderIconLink href="/chat" label="צ׳אט פנימי" icon={MessagesSquare} />}
        {showWhatsapp && <HeaderIconLink href="/messages" label="צ׳אט וואטסאפ" icon={MessageCircle} />}
        {hasIcons && <span className="h-[30px] w-px bg-line" aria-hidden />}
        <UserPill />
      </div>
    </header>
  );
}

/** Quick-link icon button styled to match NotificationBell's trigger. No badge —
 *  there is no in-header unread source for chat/WhatsApp, so per the badge rule
 *  these stay count-less (a real source can attach one later). */
function HeaderIconLink({ href, label, icon: Icon }: { href: string; label: string; icon: LucideIcon }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            href={href}
            aria-label={label}
            className="grid h-[38px] w-[38px] place-items-center rounded-[10px] border border-line bg-surface-2 text-ink-2 transition-colors hover:bg-row-hover hover:text-ink"
          />
        }
      >
        <Icon className="h-[18px] w-[18px]" />
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

function UserPill() {
  const { user, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const name = user.full_name || user.username;
  const initial = name.charAt(0).toUpperCase();
  const roleStyles = ROLE_STYLES[user.role];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="חשבון משתמש"
            className="flex h-[44px] items-center gap-2.5 rounded-[13px] border border-line bg-white py-1 pl-3 pr-1.5 transition-colors hover:border-line-strong hover:bg-row-hover"
          />
        }
      >
        <span
          className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[10px] bg-brand-soft text-[13px] font-extrabold text-brand-text"
          aria-hidden
        >
          {initial}
        </span>
        {/* Identity from the actual logged-in user; role derives from user.role
            (roleLabel) — never from the display name. */}
        <span className="hidden flex-col items-start leading-tight sm:flex">
          <span className="text-[13px] font-extrabold text-ink">{name}</span>
          <span className="text-[10.5px] font-semibold text-ink-3">{roleLabel(user.role)}</span>
        </span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-ink-3 transition-transform', open && 'rotate-180')} />
      </PopoverTrigger>
      <PopoverContent dir="rtl" align="end" className="w-60 p-0">
        <div className="border-b border-line-soft px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-ink">{name}</span>
            <span
              className={cn(
                'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium',
                roleStyles.bg, roleStyles.fg,
              )}
            >
              {roleLabel(user.role)}
            </span>
          </div>
          <div className="font-num mt-0.5 truncate text-[11.5px] text-ink-3">{user.email}</div>
        </div>
        <div className="p-1.5">
          <button
            type="button"
            onClick={() => { setOpen(false); signOut(); }}
            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-semibold text-red-600 transition-colors hover:bg-red-50"
          >
            <LogOut className="h-4 w-4" />
            התנתק
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
