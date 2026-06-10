import { AuthLayout } from '@/components/auth/AuthLayout';
import { AcceptInviteForm } from '@/components/auth/AcceptInviteForm';

type SearchParams = Promise<{ token?: string }>;

export const runtime = 'nodejs';

export default async function AcceptInvitePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { token = '' } = await searchParams;
  return (
    <AuthLayout variant="invite">
      <AcceptInviteForm token={token || null} />
    </AuthLayout>
  );
}
