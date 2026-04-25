import { Mail } from 'lucide-react';
import { AuthLayout } from '@/components/auth/AuthLayout';
import { ResendTimer } from '@/components/auth/ResendTimer';

type SearchParams = Promise<{ email?: string }>;

export default async function ForgotPasswordSentPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { email = '' } = await searchParams;

  return (
    <AuthLayout variant="forgot">
      <div className="flex flex-col gap-5">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-emerald-100 text-emerald-600">
          <Mail className="h-7 w-7" />
        </div>

        <div className="text-center">
          <h1 className="text-2xl font-extrabold">שלחנו לך קישור</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            קישור איפוס נשלח אל <span className="font-semibold text-foreground">{email}</span>
          </p>
        </div>

        <ul className="space-y-2 text-sm text-muted-foreground">
          <li className="flex items-start gap-2">
            <span className="mt-0.5 text-primary">●</span>
            <span>בדקי גם בתיקיית הספאם</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-0.5 text-primary">●</span>
            <span>הקישור תקף ל-60 דקות</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-0.5 text-primary">●</span>
            <span>בחרי סיסמה חדשה ותתחברי</span>
          </li>
        </ul>

        <ResendTimer email={email} />
      </div>
    </AuthLayout>
  );
}
