import { Building2 } from 'lucide-react';
import { cn } from '@/lib/utils';

// The brand side of /portal/login. Portal-only: the staff login keeps its own
// LoginBrandPanel under src/components/auth and the two never share markup.
//
// One component, two shapes (the references live in ref/proof):
//   • ≥901px — tenant-portal-login.md: the right-hand 46% column. Navy→blue
//     gradient + dot grid, logo/name at the top, headline + paragraph in the
//     middle, copyright at the bottom.
//   • ≤900px — tenant-login-mobile.md: a hero the white sheet overlaps by 28px.
//     Logo/name, headline, one short line; no copyright.
//
// Deliberately NOT rendered (decided 28/09/2026): the reference's "preview
// card" (fund balance · collection rate · bars) — fabricated figures have no
// place on a real login screen.
export function PortalLoginBrand({ className }: { className?: string }) {
  return (
    <aside
      className={cn(
        'relative overflow-hidden text-white',
        // mobile hero — the 24px sits under the status bar on a notched phone
        'bg-[linear-gradient(165deg,#0E1F5C_0%,#1633A8_60%,#2A55E8_100%)] px-7 pb-16 pt-[calc(24px+env(safe-area-inset-top))]',
        // desktop column
        'min-[901px]:flex min-[901px]:flex-col min-[901px]:justify-between min-[901px]:gap-10 min-[901px]:bg-[linear-gradient(160deg,#0E1F5C_0%,#1633A8_55%,#2A55E8_100%)] min-[901px]:px-16 min-[901px]:py-14',
        className,
      )}
    >
      {/* dot grid */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(rgba(255,255,255,0.09)_1px,transparent_1px)] [background-size:20px_20px] min-[901px]:[background-size:22px_22px]"
      />

      {/* logo + name */}
      <div className="relative flex items-center gap-3 min-[901px]:gap-3.5">
        <span className="grid size-11 shrink-0 place-items-center rounded-[13px] border border-white/25 bg-white/15 min-[901px]:size-[52px] min-[901px]:rounded-[14px]">
          <Building2 className="size-[22px] min-[901px]:size-[26px]" strokeWidth={1.8} aria-hidden />
        </span>
        <span className="min-w-0">
          <span className="block font-num text-[19px] font-extrabold leading-tight min-[901px]:text-[22px]">ALMOG</span>
          <span className="mt-0.5 block text-[12.5px] font-medium text-[#C9D3FF] min-[901px]:text-[13px]">פורטל בעלי דירות</span>
        </span>
      </div>

      {/* headline + copy */}
      <div className="relative min-[901px]:max-w-[480px]">
        <p className="mt-[26px] text-[30px] font-extrabold leading-[1.2] text-balance min-[901px]:mt-0 min-[901px]:text-[42px] min-[901px]:leading-[1.15]">
          הבניין שלך, בשקיפות מלאה
        </p>
        <p className="mt-2 text-[15px] leading-[1.55] text-[#D6DEFF] text-pretty min-[901px]:hidden">
          הכנסות, הוצאות וחשבון אישי — בכף היד.
        </p>
        <p className="mt-4 hidden text-lg leading-[1.6] text-[#D6DEFF] text-pretty min-[901px]:block">
          צפו בהכנסות ובהוצאות של ועד הבית, בחשבוניות ובמצב החשבון האישי שלכם — בכל זמן.
        </p>
      </div>

      <p className="relative hidden text-[13px] text-[#AFBDF5] min-[901px]:block">© 2026 ALMOG · ניהול בניינים</p>
    </aside>
  );
}
