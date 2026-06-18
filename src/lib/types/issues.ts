// Issues (תקלות) domain types — Module 2.
// Reuses the Module 1 Notifications + Reminders infrastructure.

import type { TargetType } from './targets';

export type IssueStatus = 'open' | 'in_progress' | 'resolved' | 'closed';
export type IssuePriority = 'low' | 'normal' | 'high' | 'urgent';
export type IssueLocationType = 'apartment' | 'area' | 'general';

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
  assigned_to_user_id: string | null;
  images: string[]; // storage object paths (not URLs)
  resolution_notes: string | null;
  resolved_at: string | null;
  is_archived: boolean;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
}

/** Issue enriched with the assignee display name + comment count + linked task. */
export interface IssueWithMeta extends Issue {
  assigned_to_name: string | null;
  comment_count: number;
  linked_task_id: string | null;
}

/** Fields a client may write on create/update (all optional on update). */
export interface IssueWritableFields {
  title: string;
  description: string | null;
  location_type: IssueLocationType;
  location_text: string | null;
  target_type: TargetType | null;
  target_id: string | null;
  priority: IssuePriority;
  status: IssueStatus;
  assigned_to_user_id: string | null;
  resolution_notes: string | null;
}

export type IssueSort = 'created_desc' | 'priority_desc' | 'updated_desc' | 'status_asc';

export interface IssueListFilters {
  status?: IssueStatus;
  priority?: IssuePriority;
  assignedTo?: string;
  search?: string;
  sort?: IssueSort;
  includeArchived?: boolean;
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
