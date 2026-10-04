// Issues (תקלות) domain types — Module 2.
// Reuses the Module 1 Notifications + Reminders infrastructure.

import type { TargetType } from './targets';
import type { AssigneeRef } from './assignee';
import type { PortalRole } from '@/lib/portal/identity';

export type IssueStatus = 'open' | 'in_progress' | 'resolved' | 'closed';
export type IssuePriority = 'normal' | 'high' | 'urgent';
export type IssueLocationType = 'apartment' | 'area' | 'general';
/** Who opened the issue (migration 20261003074737): the staff screen, or an
 *  owner through the portal's fault report (/portal/report). */
export type IssueSource = 'staff' | 'portal';
/** A kanban column a card can sit in (issues.board_column, 04/10/2026) —
 *  "בוצע" is not one: a resolved / closed issue is there by its status. */
export type IssueBoardColumn = 'awaiting' | 'today' | 'in_progress';

export interface Issue {
  id: string;
  title: string;
  description: string | null;
  location_type: IssueLocationType;
  location_text: string | null;
  /** Optional polymorphic target: 'room' → debtors.id, 'area' → areas.id. */
  target_type: TargetType | null;
  target_id: string | null;
  priority: IssuePriority;
  status: IssueStatus;
  /** Optional due date (migration 054) — an issue with a due_date surfaces on
   *  the calendar, mirroring tasks. 'YYYY-MM-DD' or null. */
  due_date: string | null;
  /** Optional due time-of-day (migration 054) — 'HH:MM' (sliced from HH:MM:SS)
   *  or null. Without it the issue is an all-day calendar item. */
  due_time: string | null;
  // Handlers (users + suppliers) now live in the entity_assignees junction
  // (migration 047), exposed as `assignees` on IssueWithMeta — NOT scalar
  // columns here. Legacy assigned_to_user_id / supplier_id stay frozen in the DB.
  images: string[]; // storage object paths (not URLs)
  videos: string[]; // storage object paths (not URLs) — migration 064, same bucket as images
  resolution_notes: string | null;
  resolved_at: string | null;
  is_archived: boolean;
  /** Order inside the kanban column, ascending (migration 20261004180139). */
  sort_order: number;
  /** The kanban column, set at insert from the computed rule and afterwards
   *  only by a drag. null = computed live (lib/issues/board.ts). */
  board_column: IssueBoardColumn | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
  source: IssueSource;
  // ── Portal reports only (null on staff rows) ──────────────────────────────
  // A snapshot taken from the portal session at report time. The reporter's
  // PHONE is deliberately not here: it is never part of a list/detail row and
  // reaches the panel only through GET /api/issues/[id], for contacts:view.
  reporter_name: string | null;
  reporter_apartment: string | null;
  /** The role held in reporter_apartment (בעלים / שוכר / מפעיל); null when
   *  unidentified. */
  reporter_role: PortalRole | null;
  /** "מיקום" and "קומה / אזור" exactly as the resident typed them. */
  reporter_location: string | null;
  reporter_area: string | null;
  /** The "מספר קריאה" the resident was shown. */
  ticket_number: number | null;
}

/** Issue enriched with its assignee set (json-agg over the junction) + comment count + linked task. */
export interface IssueWithMeta extends Issue {
  assignees: AssigneeRef[];
  comment_count: number;
  linked_task_id: string | null;
  /** Resolved display label for the optional target (apartment number / area
   *  name), derived in the list/detail query. null when there is no target. */
  target_label: string | null;
}

/** Fields a client may write on create/update (all optional on update). */
export interface IssueWritableFields {
  title: string;
  description: string | null;
  target_type: TargetType | null;
  target_id: string | null;
  priority: IssuePriority;
  status: IssueStatus;
  resolution_notes: string | null;
  due_date: string | null; // 'YYYY-MM-DD'
  due_time: string | null; // 'HH:MM'
}

export type IssueSort = 'created_desc' | 'priority_desc' | 'updated_desc' | 'status_asc';

export interface IssueListFilters {
  status?: IssueStatus;
  priority?: IssuePriority;
  assignedTo?: string;
  supplier_id?: string;
  search?: string;
  sort?: IssueSort;
  includeArchived?: boolean;
  /** "מדיירים" — only issues opened from the owners portal. */
  source?: IssueSource;
  /** "ממתין לשיוך" — a computed filter, not a status: status 'open', not
   *  archived, and no handler at all (no user AND no supplier in
   *  entity_assignees). 'in_progress' is excluded on purpose. */
  awaitingAssignment?: boolean;
}

export interface IssueComment {
  id: string;
  issue_id: string;
  content: string;
  author_id: string | null;
  author_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface IssueKpis {
  open: number;
  urgent: number;
  resolvedThisMonth: number;
}

/** An issue image with a freshly-signed view URL (issued per request). */
export interface IssueImage {
  path: string;
  signed_url: string | null;
}
