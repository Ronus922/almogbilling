import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { SmtpSettingsCard } from '@/components/settings/SmtpSettingsCard';
import { GreenApiSettingsCard } from '@/components/settings/GreenApiSettingsCard';
import { WhatsAppTemplatesManager } from '@/components/settings/whatsapp/WhatsAppTemplatesManager';

export const runtime = 'nodejs';

export default async function SettingsPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  if (!hasPermission(actor.role, actor.permissions, 'settings', 'view')) {
    redirect('/dashboard');
  }

  const canManageTemplates = hasPermission(actor.role, actor.permissions, 'whatsapp_templates', 'view');

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-extrabold">הגדרות</h1>
        <p className="mt-1 text-sm text-muted-foreground">ניהול הגדרות מערכת — אדמין בלבד.</p>
      </div>

      <SmtpSettingsCard />
      <GreenApiSettingsCard />
      {canManageTemplates && <WhatsAppTemplatesManager />}
    </div>
  );
}
