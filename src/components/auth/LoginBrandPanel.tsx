import { Building2, Check } from 'lucide-react';

// Marketing "brand" panel shown on the right side (RTL) of the login card.
// Dark-blue gradient with the ALMOG identity + a few value points. Login-only;
// the other auth screens (forgot/reset/invite) keep <FeaturesCard>.
// Decorative gradients/grid are Tailwind arbitrary utilities (not inline style).

const VALUE_POINTS = [
  'ניהול דיירים ובעלי דירות במקום אחד',
  'מעקב חובות ותשלומים אוטומטי',
  'התראות, משימות והליכים משפטיים',
];

export function LoginBrandPanel() {
  return (
    <div className="relative hidden w-[44%] shrink-0 flex-col justify-between overflow-hidden bg-[linear-gradient(155deg,#0e2356_0%,#1b46b0_55%,#2563eb_100%)] p-12 lg:flex">
      {/* decorative glows + dotted grid */}
      <div
        aria-hidden
        className="pointer-events-none absolute -start-16 -top-20 h-72 w-72 rounded-full bg-[radial-gradient(circle,rgba(96,165,250,0.55),transparent_70%)] blur-[8px]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-24 -end-14 h-80 w-80 rounded-full bg-[radial-gradient(circle,rgba(37,99,235,0.6),transparent_70%)] blur-[10px]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(rgba(255,255,255,0.10)_1px,transparent_1px)] opacity-50 [background-size:24px_24px]"
      />

      {/* logo + name */}
      <div className="relative">
        <div className="mb-6 grid h-16 w-16 place-items-center rounded-[18px] border border-white/25 bg-white/15 backdrop-blur-sm">
          <Building2 className="h-8 w-8 text-white" strokeWidth={1.7} aria-hidden />
        </div>
        <h1 className="text-[32px] font-extrabold leading-tight tracking-tight text-white">
          ALMOG CRM
        </h1>
        <p className="mt-2 text-[15px] font-medium text-blue-100/85">
          מערכת ניהול דיירים וגבייה
        </p>
      </div>

      {/* value points */}
      <ul className="relative flex flex-col gap-4">
        {VALUE_POINTS.map((point) => (
          <li key={point} className="flex items-center gap-3">
            <span
              aria-hidden
              className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-white/15"
            >
              <Check className="h-[15px] w-[15px] text-white" strokeWidth={2.4} />
            </span>
            <span className="text-[14.5px] font-medium text-blue-50/95">{point}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
