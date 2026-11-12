'use client';

import { useId, useRef, type MouseEvent } from 'react';
import Link from 'next/link';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { categoryKind, type BadgeTone, type MenuItem, type NavCategory } from './nav';
import type { NavIcon } from './navIcons';
import { CollapseChevrons, LogoMark, RailLogout } from './navIcons';

// The navigation surface, shared by the desktop Sidebar and the mobile drawer: a dark rail of
// category buttons (72px) and a white panel (236px) listing the items of ONE category.
// Pixel values are the reference's own (ref/sidebar-rail/"Sidebar B - Rail.html"), written as
// arbitrary px values — the root font-size is 17px, so rem utilities would be 6% off.
// DESIGN.md §14 declares the places this deliberately departs from the generic rules (the 12px
// rail label, 28px collapse button, the reference's own paddings, the link category).
// A category with ONE permitted item is a direct link (no panel); two or more switch the panel.
// Where the panel goes (`placement`): in a column beside the content ('inline' — desktop, 1024px and
// up), or floating over it ('overlay' — tablets, 768–1023px, see useTabletNav). Mobile has its own
// container (the drawer) and never uses either.

export interface NavRailProps {
  categories: NavCategory[];
  /** The category the panel lists (null → no panel at all: nothing permitted). */
  shown: NavCategory | null;
  open: boolean;
  /** Width transition on (after the first click). */
  animate: boolean;
  highlightedId: string | null;
  activeHref: string | null;
  /** desktop: the panel pushes the content and has a collapse button; mobile: it lives in
   *  the drawer, never collapses, and its items are 44px tall. */
  variant: 'desktop' | 'mobile';
  /** desktop only. 'inline': the panel is a column beside the content and pushes it (and is hidden by
   *  CSS below 1024px, so a tablet never sees it before the client has chosen). 'overlay': the panel is
   *  rendered only while open, floating next to the rail over a dimmed content area; a click on the dim
   *  area closes it (`onClosePanel`). */
  placement?: 'inline' | 'overlay';
  /** A click on a PANEL category: switches what the panel lists (never navigates). */
  onSelectCategory: (id: string) => void;
  /** A click on a LINK category: the link navigates, the panel steps aside. */
  onOpenLink: () => void;
  onClosePanel?: () => void;
  /** Fired after an item navigates — lets the mobile drawer close itself. */
  onNavigate?: () => void;
  onSignOut: () => void;
}

export function NavRail({
  categories, shown, open, animate, highlightedId, activeHref, variant, placement = 'inline',
  onSelectCategory, onOpenLink, onClosePanel, onNavigate, onSignOut,
}: NavRailProps) {
  const panelId = useId();
  const railRef = useRef<HTMLElement>(null);
  const scrolling = categories.filter((c) => !c.pinned);
  const pinned = categories.filter((c) => c.pinned);
  // The drawer and the tablet overlay keep no panel in the DOM while none is shown (the drawer's width
  // follows its content); the desktop's inline panel stays mounted so it can animate open and shut.
  const overlay = placement === 'overlay';
  const panelMounted = !!shown && ((variant === 'desktop' && !overlay) || open);
  const categoryButton = (c: NavCategory) => {
    if (categoryKind(c) === 'link') {
      const item = c.items[0]!;
      return (
        <RailLink
          key={c.id}
          icon={c.icon}
          label={c.label}
          category={c.id}
          href={item.href}
          selected={highlightedId === c.id}
          current={!!item.href && item.href === activeHref}
          onClick={(e) => {
            // Ctrl/Cmd/Shift-click opens the page elsewhere: this tab stays as it is.
            if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            onOpenLink();
            onNavigate?.();
          }}
        />
      );
    }
    return (
      <RailButton
        key={c.id}
        icon={c.icon}
        label={c.label}
        selected={highlightedId === c.id}
        expanded={open && shown?.id === c.id}
        controls={panelMounted ? panelId : undefined}
        category={c.id}
        onClick={() => onSelectCategory(c.id)}
      />
    );
  };

  return (
    <>
      {/* Tablet overlay: the dimmed content area. It sits at the bottom of the sidebar's own stacking
          context, under the rail and the panel, so a click on either never reaches it. */}
      {overlay && open && (
        <div aria-hidden data-nav-scrim onClick={onClosePanel} className="fixed inset-0 z-0 bg-slate-950/40" />
      )}
      <nav
        ref={railRef}
        aria-label="קטגוריות ניווט"
        className={cn(
          'flex w-[72px] shrink-0 flex-col items-center gap-[4px] bg-rail py-[14px]',
          variant === 'desktop' && 'md:max-lg:relative md:max-lg:z-10',
        )}
      >
        <div className="shrink-0 pb-[10px]">
          <span className="grid h-[40px] w-[40px] place-items-center rounded-[12px] bg-brand text-white">
            <LogoMark size={20} strokeWidth={2} />
          </span>
        </div>
        {/* Short windows: only the categories scroll (no visible scrollbar); the logo above
            and settings + logout below stay put. */}
        <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-[4px] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {scrolling.map(categoryButton)}
        </div>
        <div className="flex shrink-0 flex-col items-center gap-[4px]">
          {pinned.map(categoryButton)}
          <RailButton icon={RailLogout} label="יציאה" ariaLabel="התנתק" danger onClick={onSignOut} />
        </div>
      </nav>
      {shown && panelMounted && (
        <NavPanel
          id={panelId}
          category={shown}
          open={open}
          animate={animate}
          variant={variant}
          placement={placement}
          activeHref={activeHref}
          onClose={onClosePanel && (() => {
            onClosePanel();
            // The collapse button lives in the panel that is about to go inert: hand the focus
            // to the rail button of the category that was shown, or a keyboard user loses it.
            railRef.current?.querySelector<HTMLElement>(`[data-nav-category="${shown.id}"]`)?.focus();
          })}
          onNavigate={onNavigate}
        />
      )}
    </>
  );
}

// One look for every control of the rail — 12px/600 label on one line (DESIGN.md §14).
const RAIL_CONTROL =
  'flex w-[52px] shrink-0 flex-col items-center gap-[3px] whitespace-nowrap rounded-[11px] px-0 py-[9px] text-[12px] font-semibold leading-[normal] [transition:background_.13s,color_.13s] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white/80';

function railTone(selected?: boolean, danger?: boolean): string {
  return selected
    ? 'bg-brand text-white'
    : danger
      ? 'text-rail-ink hover:bg-rail-danger-bg hover:text-rail-danger'
      : 'text-rail-ink hover:bg-rail-hover hover:text-white';
}

function RailButton({
  icon: Icon, label, selected, expanded, controls, ariaLabel, category, danger, onClick,
}: {
  icon: NavIcon;
  label: string;
  selected?: boolean;
  expanded?: boolean;
  controls?: string;
  ariaLabel?: string;
  category?: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      aria-expanded={category ? expanded : undefined}
      aria-controls={category ? controls : undefined}
      data-nav-category={category}
      data-nav-kind={category ? 'panel' : undefined}
      data-selected={selected ? 'true' : undefined}
      className={cn(RAIL_CONTROL, railTone(selected, danger))}
    >
      <Icon size={19} strokeWidth={1.9} />
      {label}
    </button>
  );
}

// A category with one permitted item: the rail button is that item's link — no panel, no
// aria-expanded. `current` is the semantic truth (this IS the page you are on); `selected` is
// the rail's mark, which follows the panel while one is shown. An item whose route is not wired
// yet ("בקרוב") is muted and inert, like the same item in a panel.
function RailLink({
  icon: Icon, label, category, href, selected, current, onClick,
}: {
  icon: NavIcon;
  label: string;
  category: string;
  href: string | undefined;
  selected: boolean;
  current: boolean;
  onClick: (e: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const content = (
    <>
      <Icon size={19} strokeWidth={1.9} />
      {label}
    </>
  );
  if (!href) {
    return (
      <Tooltip>
        <TooltipTrigger render={<span className="block" />}>
          <span
            aria-disabled="true"
            data-nav-category={category}
            data-nav-kind="link"
            className={cn(RAIL_CONTROL, 'cursor-not-allowed text-rail-ink/50')}
          >
            {content}
          </span>
        </TooltipTrigger>
        <TooltipContent side="left">בקרוב</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Link
      href={href}
      onClick={onClick}
      aria-current={current ? 'page' : undefined}
      data-nav-category={category}
      data-nav-kind="link"
      data-selected={selected ? 'true' : undefined}
      className={cn(RAIL_CONTROL, railTone(selected))}
    >
      {content}
    </Link>
  );
}

function NavPanel({
  id, category, open, animate, variant, placement, activeHref, onClose, onNavigate,
}: {
  id: string;
  category: NavCategory;
  open: boolean;
  animate: boolean;
  variant: 'desktop' | 'mobile';
  placement: 'inline' | 'overlay';
  activeHref: string | null;
  onClose?: () => void;
  onNavigate?: () => void;
}) {
  return (
    <div
      id={id}
      data-nav-panel={category.id}
      data-state={open ? 'open' : 'closed'}
      // A closed panel is 0px wide and transparent, but its links are still in the DOM — inert
      // keeps them out of the tab order and the accessibility tree.
      inert={!open}
      className={cn(
        'flex flex-col overflow-hidden bg-white',
        placement === 'overlay'
          // Tablet: floats next to the rail (the rail is 72px, on the start side), over the content,
          // full height, above the scrim. Mounted only while open, so it fades in instead of sliding
          // its width. `start` is the rail's side under dir=rtl.
          ? 'absolute inset-y-0 start-[72px] z-10 w-[236px] border-x border-line shadow-soft-md animate-in fade-in-0 duration-150 motion-reduce:animate-none'
          : cn(
              // Desktop: fixed 236. The drawer is max-w-full, so on a screen narrower than 308px the
              // panel gives way (its labels truncate) instead of hanging past the edge.
              variant === 'desktop' ? 'shrink-0' : 'min-w-0 shrink',
              // The line toward the content (desktop only — the drawer has its own edge) goes with
              // the panel when it closes; the line toward the rail is the reference's own.
              variant === 'desktop' ? 'border-x border-line' : 'border-s border-line',
              animate && '[transition:width_.22s_cubic-bezier(.4,0,.2,1),opacity_.18s]',
              open ? 'w-[236px] opacity-100' : 'w-0 border-x-0 opacity-0',
              // 768–1023: the column is not used (the overlay above is) — display:none also takes its links
              // out of the tab order and the accessibility tree. From 1024 this class does nothing.
              variant === 'desktop' && 'max-lg:hidden',
            ),
      )}
    >
      {/* min-width keeps the content from re-wrapping while the panel animates to 0. */}
      <div className={cn('flex h-full flex-col', variant === 'desktop' ? 'w-[236px] min-w-[236px]' : 'w-full min-w-0')}>
        <div className="relative flex flex-col gap-[2px] px-[16px] pb-[10px] pt-[18px]">
          <div className="text-[16px] leading-[normal]">
            {/* A <b>, like the reference — not a heading: it would add an h2 to every page. */}
            <b className="text-[15px] font-extrabold text-ink">{category.title}</b>
          </div>
          <p className="text-[11.5px] font-medium leading-[normal] text-ink-3">{category.description}</p>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              title={placement === 'overlay' ? 'סגירת תפריט' : 'כיווץ תפריט'}
              aria-label={placement === 'overlay' ? 'סגירת תפריט' : 'כיווץ תפריט'}
              className="absolute end-[10px] top-[16px] grid h-[28px] w-[28px] place-items-center rounded-[8px] text-ink-ghost [transition:background_.13s,color_.13s] hover:bg-row-hover hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand"
            >
              <CollapseChevrons size={15} strokeWidth={2} />
            </button>
          )}
        </div>
        <nav aria-label={category.title} className="flex min-h-0 flex-1 flex-col gap-[1px] overflow-y-auto px-[10px] pb-[14px] pt-[4px]">
          {category.items.map((item) => (
            <PanelItem
              key={item.label}
              item={item}
              active={!!item.href && item.href === activeHref}
              variant={variant}
              onNavigate={onNavigate}
            />
          ))}
        </nav>
      </div>
    </div>
  );
}

const BADGE_TONE: Record<BadgeTone, string> = {
  default: 'bg-[#eef1f6] text-[#64748b]',
  warn: 'bg-[#fdecec] text-[#dc2626]',
  green: 'bg-[#e7f7ee] text-[#16a34a]',
};

function PanelItem({
  item, active, variant, onNavigate,
}: {
  item: MenuItem;
  active: boolean;
  variant: 'desktop' | 'mobile';
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  const ready = !!item.href;
  const className = cn(
    'flex w-full items-center gap-[10px] rounded-[9px] px-[10px] py-[9px] text-start text-[13.5px] font-semibold leading-[normal] [transition:background_.12s,color_.12s] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand',
    variant === 'mobile' && 'min-h-[44px]',
    !ready
      ? 'cursor-not-allowed text-ink-ghost'
      : active
        ? 'bg-brand-soft text-brand-text'
        : 'text-ink-2 hover:bg-row-hover hover:text-ink',
  );
  const content = (
    <>
      <Icon size={16} strokeWidth={1.9} className={cn('shrink-0', active ? 'text-brand-text' : 'text-ink-3')} />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.badge && item.badge.count > 0 && (
        <span className={cn('grid h-[21px] min-w-[21px] place-items-center rounded-full px-1.5 text-[11.5px] font-extrabold', BADGE_TONE[item.badge.tone ?? 'default'])}>
          {item.badge.count}
        </span>
      )}
    </>
  );

  // An item whose route is not wired yet stays visible, muted, with a "בקרוב" tooltip.
  if (!ready) {
    return (
      <Tooltip>
        <TooltipTrigger render={<span className="block" />}>
          <span aria-disabled="true" className={className}>{content}</span>
        </TooltipTrigger>
        <TooltipContent side="left">בקרוב</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Link
      href={item.href!}
      aria-current={active ? 'page' : undefined}
      data-nav-item={item.href}
      onClick={onNavigate}
      className={className}
    >
      {content}
    </Link>
  );
}
