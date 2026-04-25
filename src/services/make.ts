// Stub. TODO: replace with real MAKE webhook calls in phase B.

export async function triggerMakeWebhook(url: string, payload: unknown) {
  console.log('[make:stub] →', { url, payload });
  return { ok: true, mocked: true };
}
