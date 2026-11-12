'use client';

import { useState } from 'react';
import { ChevronDown, LogOut } from 'lucide-react';
import { NotificationBell } from './NotificationBell';
import { WhatsappBell } from './WhatsappBell';
import { InternalChatBell } from './InternalChatBell';
import { GlobalSearch } from './GlobalSearch';
import { MobileNav } from './MobileNav';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useAuth, usePermissions } from '@/lib/auth/context';
import { ROLE_STYLES, isGuardRole, roleLabel } from '@/lib/permissions/constants';
import { canUseNotifications } from '@/lib/permissions/check';
import { cn } from '@/lib/utils';

export function Header() {
  const { user } = useAuth();
  const { can } = usePermissions();

  // Notifications (bell) are hidden from the read-only `viewer`, who is scoped to
  // the debtors screen only — same boundary enforced on /notifications and the
  // /api/notifications/* routes. Gating here (not inside NotificationBell) keeps
  // the bell from ever mounting/polling for a viewer. The InternalChatBell and the
  // WhatsappBell (each its own badge + popover, fed by its own slice of
  // /api/notifications) reuse the same per-module RBAC as their sidebar entries
  // (no new gate). The guard (one screen: the visitor scan) is hidden from the
  // bell and from the global search the same way — canUseNotifications().
  const showNotifications = canUseNotifications(user.role);
  const showSearch = !isGuardRole(user.role);
  const showChat = can('internal_chat', 'view');
  const showWhatsapp = can('whatsapp_chat', 'view');
  const hasIcons = showNotifications || showChat || showWhatsapp;

  return (
    <header className="flex h-16 shrink-0 items-center gap-4 border-b border-line bg-white/90 px-6 backdrop-blur">
      {/* Right (RTL start): mobile nav trigger + global search. The hamburger is
          md:hidden (the desktop Sidebar covers ≥md); search collapses on mobile
          so the hamburger is always reachable and nothing gets crammed. */}
      <MobileNav />
      {showSearch && (
        // 768–1023 only (`md:max-lg:`): the search may shrink below the width of its own placeholder (the
        // text is cut with an ellipsis) — its content-based minimum (~325px) is what pushed the user menu
        // off the edge when the name was long. ≥1024 and the phone are untouched.
        <div className="hidden w-full max-w-[440px] items-center md:flex md:max-lg:min-w-0 md:max-lg:[&>button]:min-w-0">
          <GlobalSearch />
        </div>
      )}

      <div className="flex-1" />

      {/* Left (RTL end): whatsapp / internal-chat / bell icons + user pill. DOM
          order = visual right→left under dir=rtl, i.e. WhatsApp, internal chat,
          bell — matching the header spec. */}
      <div className="flex items-center gap-2.5">
        {showWhatsapp && <WhatsappBell />}
        {showChat && <InternalChatBell />}
        {showNotifications && <NotificationBell />}
        {hasIcons && <span className="h-[30px] w-px bg-line" aria-hidden />}
        <UserPill />
      </div>
    </header>
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
        {/* 768–1023 (tablets): the name and the role stay on one line each — the search gives way
            instead — and a very long name is cut. Without it the pill was squeezed below its natural
            width and the text wrapped out of the button. Desktop and phone are untouched. */}
        <span className="hidden flex-col items-start leading-tight sm:flex md:max-lg:whitespace-nowrap">
          <span className="text-[13px] font-extrabold text-ink md:max-lg:max-w-[9rem] md:max-lg:truncate">{name}</span>
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
          <div className="font-num mt-0.5 truncate text-[11.5px] text-ink-3">{user.email ?? user.username}</div>
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
