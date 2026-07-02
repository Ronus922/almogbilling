import type { ReactNode } from 'react';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { AgentFab } from '@/components/agent/AgentFab';

// Shell skeleton (see DESIGN.md §32): a full-height RTL flex ROW — the Sidebar is
// the right-edge column (its brand block reaches the very top), and the content
// area (Header + scrolling <main>) is a flex column beside it. The Header lives
// INSIDE the content column, so it never spans above the sidebar. The brand block
// and the Header share the same height (h-16), so their bottom borders line up.
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen bg-app">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-auto bg-app">
          <div className="mx-auto max-w-[1640px] p-[18px] md:p-6">{children}</div>
        </main>
      </div>
      {/* Floating read-only collection assistant — self-gates on dashboard/contacts view. */}
      <AgentFab />
    </div>
  );
}
