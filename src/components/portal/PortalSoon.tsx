import type { ReactNode } from 'react';

// The reference's #t-soon: a centred card with a tile icon, a title and one
// line — "החשבון שלי" and "החלטות" today, and any tab with nothing to show.
export function PortalSoon({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return (
    <section>
      <div className="card empty">
        <div className="ic">{icon}</div>
        <h2>{title}</h2>
        <p>{text}</p>
      </div>
    </section>
  );
}
