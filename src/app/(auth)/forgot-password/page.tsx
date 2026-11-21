import { AuthLayout } from '@/components/auth/AuthLayout';
import { ForgotPasswordForm } from '@/components/auth/ForgotPasswordForm';
import { redirectIfSignedIn } from '@/lib/auth/signedIn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// A visitor who is really signed in goes home; a dead cookie gets the form.
export default async function ForgotPasswordPage() {
  await redirectIfSignedIn();
  return (
    <AuthLayout variant="forgot">
      <ForgotPasswordForm />
    </AuthLayout>
  );
}
