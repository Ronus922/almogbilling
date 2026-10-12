// תקלות (issues) + משימות (tasks) — two separate screens sharing one design
// and one row shape (12/10/2026, Decisions Log: "עיצוב משותף, ישויות נפרדות"
// cancels the 11/10/2026 unification). Each screen's list/board/KPI query
// touches ONLY its own table (src/lib/db/workItems.ts) — `kind` tags a row
// with which table it came from and which per-kind API to call for
// mutations; it is never used to combine issues and tasks in one query.

/** New 3-state source of truth, derived server-side from the legacy `status`
 *  column on every write (see src/lib/workItems/status.ts) — never set
 *  directly by a client. The legacy `status` (+ issues.board_column) stay as
 *  they are, read only by the retired-from-nav screens. */
export type WorkItemStatusV2 = 'open' | 'in_progress' | 'closed';

export type WorkItemKind = 'issue' | 'task';

/** Who may be the single primary assignee of an item. */
export type WorkItemAssigneeKind = 'user' | 'supplier';

export interface WorkItemPrimaryAssignee {
  kind: WorkItemAssigneeKind;
  id: string;
  display_name: string;
}

/** One normalized row from the combined issues+tasks feed — the shape the
 *  unified list/board/KPIs render. Each field maps 1:1 to a real column on the
 *  underlying table; `kind` says which table + which per-kind API to call for
 *  mutations (the unified feed is read-only). */
export interface WorkItem {
  kind: WorkItemKind;
  id: string;
  title: string;
  priority: 'normal' | 'high' | 'urgent';
  status_v2: WorkItemStatusV2;
  blocked: boolean;
  blocked_reason: string | null;
  due_date: string | null;
  assignee: WorkItemPrimaryAssignee | null;
  /** 'staff' | 'portal' (issues) or 'staff' | 'tenant' (tasks) — normalized to
   *  a single boolean for display; the raw value is kept for completeness. */
  source: string;
  is_from_resident: boolean;
  source_apartment: string | null;
  source_reporter_name: string | null;
  comment_count: number;
  attachment_count: number;
  is_recurring: boolean;
  is_recurring_paused: boolean;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  sort_index: number | null;
  /** created in the last 24h and still unassigned — the "חדש" tag. */
  is_new: boolean;
  /** Full multi-assignee set (entity_assignees), for the avatar stack next to
   *  the primary assignee — a card/row never duplicates across lanes/rows,
   *  it shows once (at the primary) with this list alongside it. */
  assignees: WorkItemPrimaryAssignee[];
}

export type WorkItemViewTab = 'active' | 'recurring' | 'archive';

export interface WorkItemListFilters {
  tab: WorkItemViewTab;
  assigneeUserId?: string | 'unassigned';
  priority?: 'normal' | 'high' | 'urgent';
  search?: string;
}

export interface WorkItemKpis {
  urgentActive: number;
  unassigned: number;
  dueToday: number;
  overdue: number;
}
