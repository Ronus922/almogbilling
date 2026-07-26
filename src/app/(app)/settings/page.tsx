import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { SmtpSettingsCard } from '@/components/settings/SmtpSettingsCard';
import { BillingSettingsCard } from '@/components/settings/BillingSettingsCard';
import { WhatsAppConnections } from './components/WhatsAppConnections';

export const runtime = 'nodejs';

export default async function SettingsPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  if (!hasPermission(actor.role, actor.permissions, 'settings', 'view')) {
    redirect('/dashboard');
  }

  const isAdmin = actor.role === 'admin' || actor.role === 'super_admin';

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold text-slate-900">הגדרות</h1>
        <p className="mt-1 text-sm text-muted-foreground">ניהול הגדרות מערכת — אדמין בלבד.</p>
      </div>

      <BillingSettingsCard />
      <SmtpSettingsCard />
      <WhatsAppConnections isAdmin={isAdmin} currentUserId={actor.id} />
    </div>
  );
}
