import { AlmogLogo } from '@/components/common/AlmogLogo';
import { Users, FileSpreadsheet, History, Zap, Mail } from 'lucide-react';

type Variant = 'login' | 'forgot' | 'reset';

interface Feature {
  icon: React.ComponentType<{ className?: string }>;
  text: string;
}

const LOGIN_FEATURES: Feature[] = [
  { icon: Users, text: 'ניהול דיירים ובעלי דירות — כולל סנכרון WhatsApp' },
  { icon: FileSpreadsheet, text: 'מעקב חובות אוטומטי מקובץ Excel של חברת הניהול' },
  { icon: History, text: 'היסטוריית סטטוסים משפטיים ומעקב תביעות' },
  { icon: Zap, text: 'אוטומציות: Make, Green API, Resend, Gmail' },
];

const FORGOT_STEPS: Feature[] = [
  { icon: Mail, text: 'נכנסים לאימייל ולוחצים על הקישור שקיבלתם' },
  { icon: FileSpreadsheet, text: 'קובעים סיסמה חדשה (לפחות 8 תווים)' },
  { icon: Zap, text: 'מתחברים מחדש עם הסיסמה החדשה' },
];

const TITLES: Record<Variant, { headline: string; sub?: string }> = {
  login: {
    headline: 'הכל מה שצריך לניהול גבייה בבניין — במקום אחד.',
    sub: 'חובות, תקשורת, משימות, מסמכים, והליכים משפטיים — בזרימה אחת, עם אוטומציות שחוסכות שעות בשבוע.',
  },
  forgot: {
    headline: 'שכחת סיסמה? קורה לכולם.',
    sub: 'נשלח אליך קישור לאימייל. תהליך האיפוס לוקח דקה.',
  },
  reset: {
    headline: 'שכחת סיסמה? קורה לכולם.',
    sub: 'בחירת סיסמה חדשה ומאובטחת. שניות בודדות וזה מאחוריך.',
  },
};

export function FeaturesCard({ variant }: { variant: Variant }) {
  const features = variant === 'login' ? LOGIN_FEATURES : FORGOT_STEPS;
  const { headline, sub } = TITLES[variant];

  return (
    <div className="hidden flex-col gap-8 lg:flex">
      <AlmogLogo />
      <div>
        <h1 className="text-3xl font-extrabold leading-snug">{headline}</h1>
        {sub && <p className="mt-3 text-sm text-muted-foreground leading-relaxed max-w-md">{sub}</p>}
      </div>
      <ul className="space-y-4">
        {features.map((f, i) => (
          <li key={i} className="flex items-center gap-4 text-sm text-foreground/90">
            <span
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-blue-50 text-blue-600"
              aria-hidden
            >
              <f.icon className="h-5 w-5" />
            </span>
            <span>{f.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
