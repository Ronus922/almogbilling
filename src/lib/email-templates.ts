import 'server-only';
import { resetPasswordTemplate } from '@/templates/email/reset-password';
import { userInviteTemplate } from '@/templates/email/user-invite';

export type EmailTemplateName = 'reset-password' | 'user-invite';

interface RenderArgs {
  'reset-password': { userName: string; resetUrl: string };
  'user-invite': {
    inviterName: string;
    inviteeName: string;
    roleLabel: string;
    acceptUrl: string;
    validHours: number;
  };
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function renderTemplate<N extends EmailTemplateName>(
  name: N,
  data: RenderArgs[N],
): RenderedEmail {
  switch (name) {
    case 'reset-password':
      return resetPasswordTemplate(data as RenderArgs['reset-password']);
    case 'user-invite':
      return userInviteTemplate(data as RenderArgs['user-invite']);
    default:
      throw new Error(`Unknown email template: ${String(name)}`);
  }
}
