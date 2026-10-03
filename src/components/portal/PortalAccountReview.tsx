import { PORTAL_ACCOUNT_REVIEW_MESSAGE } from '@/lib/portal/ownership';
import { PortalSupportAction, type PortalSupport } from './PortalSupportAction';
import { PortalWarnNotice } from './PortalWarnNotice';

/**
 * What a mixed-owners phone sees instead of the portal's tabs (containment
 * 03/10/2026, lib/portal/ownership.ts): one inline notice, in the style of the
 * login's "המספר אינו רשום", with the management company's details already
 * open. No figure, no apartment and no name — nothing of the roster rows that
 * may not be this person's.
 */
export function PortalAccountReview({ support }: { support: PortalSupport }) {
  return (
    <section className="mx-auto w-full max-w-[560px]">
      <PortalWarnNotice
        action={<PortalSupportAction support={support} className="pbtn pbtn-secondary w-full" alwaysOpen />}
      >
        {PORTAL_ACCOUNT_REVIEW_MESSAGE}
      </PortalWarnNotice>
    </section>
  );
}
