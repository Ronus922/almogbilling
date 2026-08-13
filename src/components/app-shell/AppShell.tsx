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
    // `h-shell` = 100dvh with a 100vh fallback (app/styles/responsive.css). Plain
    // `h-screen` measures the viewport with mobile browser chrome COLLAPSED, so on
    // iOS Safari the shell ran ~60-100px taller than the visible area and the last
    // rows of every scrolling list sat behind the toolbar. `min-w-0` lets the
    // content column shrink below its content width beside the fixed sidebar —
    // without it a wide table forces the whole shell to overflow horizontally.
    <div className="h-shell flex bg-app">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-auto overscroll-contain bg-app">
          <div className="safe-px mx-auto max-w-[1640px] p-[18px] pb-[max(18px,env(safe-area-inset-bottom))] md:p-6">
            {children}
          </div>
        </main>
      </div>
      {/* Floating read-only collection assistant — self-gates on dashboard/contacts view. */}
      <AgentFab />
    </div>
  );
}
