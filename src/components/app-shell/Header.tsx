import { Building2 } from 'lucide-react';
import { UserMenu } from './UserMenu';
import { NotificationBell } from './NotificationBell';

export function Header() {
  return (
    <header className="flex h-[60px] shrink-0 items-center justify-between border-b border-line bg-white px-6">
      {/* Right (RTL start): brand */}
      <div className="flex items-center gap-2.5">
        <span className="grid h-[34px] w-[34px] place-items-center rounded-[10px] bg-gradient-to-br from-[#3d5afe] to-[#7c5cfc] text-white shadow-[0_4px_12px_rgba(61,90,254,0.35)]">
          <Building2 className="h-[18px] w-[18px]" />
        </span>
        <span className="text-[17px] font-bold text-ink">ניהול אלמוג</span>
      </div>

      {/* Left (RTL end): notifications + user */}
      <div className="flex items-center gap-3">
        <NotificationBell />
        <span className="h-7 w-px bg-line" aria-hidden />
        <UserMenu />
      </div>
    </header>
  );
}
