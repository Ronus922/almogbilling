// Areas module ("ניהול אזורים") domain types. An area is a small admin-managed
// lookup: a name, a type (closed room / open space), an optional description and
// an optional card color (hex). No responsible-contact concept.

export type AreaType = 'closed_room' | 'open_space';

export interface Area {
  id: string;
  name: string;
  area_type: AreaType;
  description: string | null;
  color: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Fields a client may write (create or whole-object update). */
export interface AreaWritableFields {
  name: string;
  area_type: AreaType;
  description: string | null;
  color: string | null;
}
