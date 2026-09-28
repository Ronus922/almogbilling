import { Building2 } from 'lucide-react';
import { cn } from '@/lib/utils';

// The brand side of /portal/login. Portal-only: the staff login keeps its own
// LoginBrandPanel under src/components/auth and the two never share markup.
//
// One component, two shapes, every value in px (the root font is 17px, so rem
// utilities would land 6.25% off the references):
//   • ≥901px — ref/proof/Tenant Portal (standalone).html `.brand`: the
//     right-hand 46% column. Navy→blue gradient + dot grid, logo/name at the
//     top, headline + paragraph + preview card in the middle, copyright at
//     the bottom, `justify-content: space-between`.
//   • ≤900px — ref/proof/Tenant Login Mobile (standalone).html `.hero`: a hero
//     the white sheet overlaps by 28px. Logo/name, headline, one short line.
//
// The preview card (fund balance · collection rate · ten bars) is the
// reference's static illustration: aria-hidden, no data behind it, desktop
// only — the reference hides it below 900px too (decision 28/09/2026).
// The only wording changes vs the reference are the approved ones
// ("פורטל בעלי דירות").

/** The reference's ten bars, heights in % of the 56px strip; odd bars white. */
const PREVIEW_BARS = [
  'h-[62%]', 'h-[48%]', 'h-[66%]', 'h-[58%]', 'h-[64%]',
  'h-[90%]', 'h-[65%]', 'h-[52%]', 'h-[67%]', 'h-[60%]',
] as const;

export function PortalLoginBrand({ className }: { className?: string }) {
  return (
    <aside
      className={cn(
        'relative overflow-hidden text-white',
        // mobile hero — the 24px sits under the status bar on a notched phone
        'bg-[linear-gradient(165deg,#0E1F5C_0%,#1633A8_60%,#2A55E8_100%)] px-[28px] pb-[64px] pt-[calc(24px+env(safe-area-inset-top))]',
        // desktop column
        'min-[901px]:flex min-[901px]:flex-col min-[901px]:justify-between min-[901px]:gap-[40px] min-[901px]:bg-[linear-gradient(160deg,#0E1F5C_0%,#1633A8_55%,#2A55E8_100%)] min-[901px]:px-[64px] min-[901px]:py-[56px]',
        className,
      )}
    >
      {/* dot grid — the references' `radial-gradient(rgba(255,255,255,.09) 1px, transparent 1px)`: 20px cell on mobile, 22px on desktop */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(rgba(255,255,255,0.09)_1px,transparent_1px)] [background-size:20px_20px] min-[901px]:[background-size:22px_22px]"
      />

      {/* logo + name */}
      <div className="relative flex items-center gap-[12px] min-[901px]:gap-[14px]">
        <span className="grid size-[44px] shrink-0 place-items-center rounded-[13px] border border-[rgba(255,255,255,0.25)] bg-[rgba(255,255,255,0.14)] min-[901px]:size-[52px] min-[901px]:rounded-[14px]">
          <Building2 className="size-[22px] min-[901px]:size-[26px]" strokeWidth={1.8} aria-hidden />
        </span>
        <span className="min-w-0">
          <span className="block font-num text-[19px] font-extrabold leading-[normal] min-[901px]:text-[22px]">ALMOG</span>
          <span className="block text-[12.5px] font-normal leading-[normal] text-[#C9D3FF] min-[901px]:mt-[2px] min-[901px]:text-[13px] min-[901px]:font-medium">
            פורטל בעלי דירות
          </span>
        </span>
      </div>

      {/* headline + copy (+ the preview card on desktop) */}
      <div className="relative min-[901px]:max-w-[480px]">
        <p className="mt-[26px] text-[30px] font-extrabold leading-[1.2] text-balance min-[901px]:mt-0 min-[901px]:text-[42px] min-[901px]:leading-[1.15]">
          הבניין שלך, בשקיפות מלאה
        </p>
        <p className="mt-[8px] text-[15px] leading-[1.55] text-[#D6DEFF] text-pretty min-[901px]:hidden">
          הכנסות, הוצאות וחשבון אישי — בכף היד.
        </p>
        <p className="mt-[16px] hidden text-[18px] leading-[1.6] text-[#D6DEFF] text-pretty min-[901px]:block">
          צפו בהכנסות ובהוצאות של ועד הבית, בחשבוניות ובמצב החשבון האישי שלכם — בכל זמן.
        </p>

        {/* preview card — static illustration, figures are the reference's */}
        <div
          data-preview
          aria-hidden
          className="mt-[36px] hidden max-w-[440px] grid-cols-2 gap-[16px] rounded-[16px] border border-[rgba(255,255,255,0.2)] bg-[rgba(255,255,255,0.1)] p-[20px] min-[901px]:grid"
        >
          <div>
            <div data-k className="text-[13px] leading-[normal] text-[#C9D3FF]">יתרת קופת הבניין</div>
            <div data-v dir="ltr" className="mt-[4px] font-num text-[24px] font-bold leading-[normal] tabular-nums">₪48,320</div>
          </div>
          <div>
            <div data-k className="text-[13px] leading-[normal] text-[#C9D3FF]">גבייה החודש</div>
            <div data-v dir="ltr" className="mt-[4px] font-num text-[24px] font-bold leading-[normal] tabular-nums">87%</div>
          </div>
          <div data-bars className="col-span-full flex h-[56px] items-end gap-[6px]">
            {PREVIEW_BARS.map((height, i) => (
              <span
                key={height}
                className={cn('flex-1 rounded-t-[4px]', height, i % 2 === 0 ? 'bg-white' : 'bg-[rgba(255,255,255,0.35)]')}
              />
            ))}
          </div>
        </div>
      </div>

      <p className="relative hidden text-[13px] leading-[normal] text-[#AFBDF5] min-[901px]:block">© 2026 ALMOG · ניהול בניינים</p>
    </aside>
  );
}
