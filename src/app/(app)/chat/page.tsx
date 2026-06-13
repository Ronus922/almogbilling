import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { ChatClient } from './components/ChatClient';

export const runtime = 'nodejs';

// /chat — internal chat between system users (gated on the internal_chat module).
export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string }>;
}) {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  if (!hasPermission(actor.role, actor.permissions, 'internal_chat', 'view')) {
    redirect('/dashboard');
  }

  const { c } = await searchParams;
  const initialConversationId = typeof c === 'string' && c.trim() ? c.trim() : null;

  return <ChatClient currentUserId={actor.id} initialConversationId={initialConversationId} />;
}
