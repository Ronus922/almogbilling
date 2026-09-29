import type { ReactNode } from 'react';

// The reference's #t-soon: a centred card with a tile icon, a title and one
// line — "החשבון שלי" and "החלטות" today, and any tab with nothing to show.
export function PortalSoon({ icon, title, text, action }: {
  icon: ReactNode;
  title: string;
  text: string;
  /** Shown under the text when the copy asks the resident to do something —
   *  today only "פנו לחברת הניהול", which gets the contact action beside it. */
  action?: ReactNode;
}) {
  return (
    <section>
      <div className="card empty">
        <div className="ic">{icon}</div>
        <h2>{title}</h2>
        <p>{text}</p>
        {action && <div className="mx-auto mt-[18px] flex w-full max-w-[320px] flex-col gap-[8px]">{action}</div>}
      </div>
    </section>
  );
}
