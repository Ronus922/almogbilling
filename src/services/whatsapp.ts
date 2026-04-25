// Stub. TODO: replace with real Green API integration in phase B.

export async function sendWhatsApp(to: string, message: string) {
  console.log('[whatsapp:stub] →', { to, message });
  return { ok: true, mocked: true, id: `wa_mock_${Date.now()}` };
}
