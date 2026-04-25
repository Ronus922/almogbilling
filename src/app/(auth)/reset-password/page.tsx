import { AuthLayout } from '@/components/auth/AuthLayout';
import { ResetPasswordForm } from '@/components/auth/ResetPasswordForm';

type SearchParams = Promise<{ token?: string }>;

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { token = '' } = await searchParams;
  return (
    <AuthLayout variant="reset">
      <ResetPasswordForm token={token || null} />
    </AuthLayout>
  );
}
