import { Bell, Building2 } from 'lucide-react';
import { UserMenu } from './UserMenu';

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
        <button
          type="button"
          aria-label="התראות"
          className="relative grid h-[38px] w-[38px] place-items-center rounded-[10px] border border-line bg-surface-2 text-ink-2 transition-colors hover:bg-row-hover"
        >
          <Bell className="h-[18px] w-[18px]" />
          <span className="absolute -top-1 -right-1 grid h-[18px] min-w-[18px] items-center justify-center rounded-full border-2 border-white bg-[#e5484d] px-1 text-[10px] font-bold leading-none text-white">
            9+
          </span>
        </button>
        <span className="h-7 w-px bg-line" aria-hidden />
        <UserMenu />
      </div>
    </header>
  );
}
