import 'server-only';
import { resetPasswordTemplate } from '@/templates/email/reset-password';
import { userInviteTemplate } from '@/templates/email/user-invite';
import { taskNotificationTemplate } from '@/templates/email/task-notification';

export type EmailTemplateName = 'reset-password' | 'user-invite' | 'task-notification';

interface RenderArgs {
  'reset-password': { userName: string; resetUrl: string };
  'user-invite': {
    inviterName: string;
    inviteeName: string;
    roleLabel: string;
    acceptUrl: string;
    validHours: number;
  };
  'task-notification': {
    recipientName: string;
    heading: string;
    taskTitle: string;
    details: { label: string; value: string }[];
    taskUrl: string;
    signatureHtml: string;
    signatureText: string;
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
    case 'task-notification':
      return taskNotificationTemplate(data as RenderArgs['task-notification']);
    default:
      throw new Error(`Unknown email template: ${String(name)}`);
  }
}
