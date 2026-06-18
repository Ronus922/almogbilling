// Shared "target" (יעד) types for the optional task/issue target field.
// A target points at either an apartment (room → debtors) or an area (areas).

export type TargetType = 'room' | 'area';

/** A reference stored on a task/issue. Both null = no target. */
export interface TargetRef {
  type: TargetType | null;
  id: string | null;
}

/** Apartment option for the picker (room). */
export interface RoomTarget {
  id: string;
  apartment_number: string;
  owner_name: string | null;
}

/** Area option for the picker. */
export interface AreaTarget {
  id: string;
  name: string;
  area_type: 'closed_room' | 'open_space';
}

/** Payload of GET /api/targets. */
export interface TargetOptions {
  rooms: RoomTarget[];
  areas: AreaTarget[];
}
