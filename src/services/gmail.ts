// Stub. TODO: replace with real Gmail API (Base44 connector or oauth) in phase B.

export async function sendViaGmail(_to: string, _subject: string, _body: string) {
  console.log('[gmail:stub] sendViaGmail called');
  return { ok: true, mocked: true };
}
