--
-- PostgreSQL database dump
--


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: reconcile_wa_campaign(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reconcile_wa_campaign(p_campaign uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
declare c record;
begin
  select
    count(*)                                    as total,
    count(*) filter (where status='pending')    as pending,
    count(*) filter (where status='processing') as processing,
    count(*) filter (where status='sent')       as sent,
    count(*) filter (where status='failed')     as failed,
    count(*) filter (where status='skipped')    as skipped,
    count(*) filter (where status='cancelled')  as cancelled
  into c
  from public.wa_campaign_recipients where campaign_id = p_campaign;

  update public.wa_campaigns w set
    total_count=c.total, pending_count=c.pending, processing_count=c.processing,
    sent_count=c.sent, failed_count=c.failed, skipped_count=c.skipped,
    cancelled_count=c.cancelled,
    status = case
      when w.status in ('cancelled','draft','paused') then w.status
      when (c.pending + c.processing) = 0 and c.total > 0
        then case when c.failed > 0 then 'completed_with_errors' else 'completed' end
      else w.status end,
    completed_at = case
      when w.status not in ('cancelled','draft','paused')
       and (c.pending + c.processing) = 0 and c.total > 0 and w.completed_at is null
        then now() else w.completed_at end
  where w.id = p_campaign;
end $$;


--
-- Name: touch_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


--
-- Name: wa_touch_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.wa_touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin new.updated_at = now(); return new; end $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: app_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_settings (
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);


--
-- Name: TABLE app_settings; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.app_settings IS 'Generic admin-only key/value settings store (jsonb).';


--
-- Name: COLUMN app_settings.value; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.app_settings.value IS 'Schema is per-key. key=smtp: { user, fromName, passEnc:{ iv, ct, tag } }. key=green_api: { instanceId, tokenEnc:{ iv, ct, tag } }. Enc fields are base64 (AES-256-GCM).';


--
-- Name: areas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.areas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    area_type text DEFAULT 'closed_room'::text NOT NULL,
    color text,
    CONSTRAINT areas_area_type_check CHECK ((area_type = ANY (ARRAY['closed_room'::text, 'open_space'::text])))
);


--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    actor_user_id uuid,
    action text NOT NULL,
    entity_type text NOT NULL,
    entity_id text,
    changes jsonb,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: auth_rate_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_rate_limits (
    id bigint NOT NULL,
    bucket text NOT NULL,
    hit_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: auth_rate_limits_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.auth_rate_limits ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.auth_rate_limits_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: calendar_event_participants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.calendar_event_participants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_id uuid NOT NULL,
    participant_source text NOT NULL,
    participant_id uuid,
    display_name_cache text,
    email_cache text,
    attendance_status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT calendar_event_participants_attendance_status_check CHECK ((attendance_status = ANY (ARRAY['pending'::text, 'accepted'::text, 'declined'::text]))),
    CONSTRAINT calendar_event_participants_participant_source_check CHECK ((participant_source = ANY (ARRAY['user'::text, 'contact'::text, 'external'::text])))
);


--
-- Name: calendar_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.calendar_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    item_kind text DEFAULT 'meeting'::text NOT NULL,
    event_date date NOT NULL,
    start_datetime timestamp with time zone,
    end_datetime timestamp with time zone,
    is_all_day boolean DEFAULT false NOT NULL,
    location text,
    description text,
    color_key text DEFAULT 'blue'::text NOT NULL,
    status text DEFAULT 'scheduled'::text NOT NULL,
    owner_user_id uuid,
    recurrence_enabled boolean DEFAULT false NOT NULL,
    recurrence_type text,
    recurrence_interval integer DEFAULT 1 NOT NULL,
    recurrence_end_type text DEFAULT 'never'::text NOT NULL,
    recurrence_until_date date,
    recurrence_count integer,
    parent_series_id uuid,
    is_exception boolean DEFAULT false NOT NULL,
    source_type text DEFAULT 'manual'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT calendar_events_item_kind_check CHECK ((item_kind = ANY (ARRAY['meeting'::text, 'event'::text]))),
    CONSTRAINT calendar_events_recurrence_end_type_check CHECK ((recurrence_end_type = ANY (ARRAY['never'::text, 'until_date'::text, 'count'::text]))),
    CONSTRAINT calendar_events_recurrence_type_check CHECK ((recurrence_type = ANY (ARRAY['daily'::text, 'weekly'::text, 'monthly'::text, 'yearly'::text]))),
    CONSTRAINT calendar_events_source_type_check CHECK ((source_type = ANY (ARRAY['manual'::text, 'generated_occurrence'::text]))),
    CONSTRAINT calendar_events_status_check CHECK ((status = ANY (ARRAY['scheduled'::text, 'completed'::text, 'cancelled'::text])))
);


--
-- Name: chat_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    debtor_id uuid,
    contact_phone text NOT NULL,
    chat_id text,
    external_message_id text,
    link_status text DEFAULT 'linked'::text NOT NULL,
    direction text NOT NULL,
    message_type text DEFAULT 'text'::text NOT NULL,
    content text,
    status text DEFAULT 'pending'::text NOT NULL,
    error_detail text,
    sent_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    broadcast_id uuid,
    media_url text,
    read_at timestamp with time zone,
    instance_id uuid,
    supplier_id uuid,
    attachment_name text,
    attachment_mime text,
    attachment_size integer,
    CONSTRAINT chat_messages_direction_check CHECK ((direction = ANY (ARRAY['sent'::text, 'received'::text]))),
    CONSTRAINT chat_messages_link_status_check CHECK ((link_status = ANY (ARRAY['linked'::text, 'unlinked'::text]))),
    CONSTRAINT chat_messages_message_type_check CHECK ((message_type = ANY (ARRAY['text'::text, 'image'::text, 'document'::text]))),
    CONSTRAINT chat_messages_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'queued'::text, 'sent'::text, 'delivered'::text, 'read'::text, 'failed'::text])))
);


--
-- Name: chip_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chip_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    chip_id uuid NOT NULL,
    event_type text NOT NULL,
    old_value jsonb,
    new_value jsonb,
    reason text,
    actor_id uuid,
    actor_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chip_events_event_type_check CHECK ((event_type = ANY (ARRAY['issued'::text, 'deactivated'::text, 'reactivated'::text, 'reassigned'::text, 'note'::text, 'controller_synced'::text])))
);


--
-- Name: chips; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chips (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    chip_number text NOT NULL,
    chip_type text DEFAULT 'physical'::text NOT NULL,
    contact_id uuid NOT NULL,
    apartment_number text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    resident_role text NOT NULL,
    holder_name text,
    holder_phone text,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    issued_by uuid,
    issued_by_name text,
    deactivated_at timestamp with time zone,
    deactivated_by uuid,
    deactivated_by_name text,
    deactivation_reason text,
    controller_synced boolean DEFAULT false NOT NULL,
    controller_synced_at timestamp with time zone,
    app_platform text,
    app_invite_status text,
    app_expires_at timestamp with time zone,
    issuance_fee numeric(10,2),
    fee_charged boolean DEFAULT false NOT NULL,
    limit_override_reason text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chips_app_invite_status_check CHECK (((app_invite_status IS NULL) OR (app_invite_status = ANY (ARRAY['pending'::text, 'active'::text, 'expired'::text])))),
    CONSTRAINT chips_app_platform_check CHECK (((app_platform IS NULL) OR (app_platform = ANY (ARRAY['ios'::text, 'android'::text, 'unknown'::text])))),
    CONSTRAINT chips_chip_type_check CHECK ((chip_type = ANY (ARRAY['physical'::text, 'app'::text]))),
    CONSTRAINT chips_deactivation_reason_check CHECK (((deactivation_reason IS NULL) OR (deactivation_reason = ANY (ARRAY['lost'::text, 'stolen'::text, 'damaged'::text, 'returned'::text, 'moved_out'::text, 'unknown'::text])))),
    CONSTRAINT chips_holder_identity_check CHECK ((((resident_role = ANY (ARRAY['other'::text, 'staff'::text])) AND (holder_name IS NOT NULL)) OR ((resident_role = ANY (ARRAY['owner'::text, 'tenant'::text, 'operator'::text])) AND (contact_id IS NOT NULL)))),
    CONSTRAINT chips_inactive_requires_reason CHECK (((status = 'active'::text) OR (deactivation_reason IS NOT NULL))),
    CONSTRAINT chips_resident_role_check CHECK (((resident_role IS NULL) OR (resident_role = ANY (ARRAY['owner'::text, 'tenant'::text, 'operator'::text, 'staff'::text, 'other'::text])))),
    CONSTRAINT chips_status_check CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text])))
);


--
-- Name: comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.comments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    debtor_id uuid NOT NULL,
    apartment_number text NOT NULL,
    content text NOT NULL,
    author_id uuid,
    author_name text NOT NULL,
    author_email text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: completed_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.completed_actions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    debtor_id uuid NOT NULL,
    apartment_number text NOT NULL,
    description text NOT NULL,
    due_date date,
    completed_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_by uuid,
    completed_by_name text NOT NULL
);


--
-- Name: contact_people; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact_people (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    contact_id uuid NOT NULL,
    role text NOT NULL,
    name text,
    phone text,
    email text,
    is_primary_contact boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT contact_people_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'tenant'::text])))
);


--
-- Name: TABLE contact_people; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.contact_people IS 'Additional owners/tenants of an apartment. The first person of each role lives in contacts.owner_*/tenant_*; these are the extras. is_primary_contact = receives WhatsApp messages/broadcasts.';


--
-- Name: contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    apartment_number text NOT NULL,
    owner_name text,
    owner_phone text,
    owner_email text,
    tenant_name text,
    tenant_phone text,
    tenant_email text,
    resident_type text DEFAULT 'owner'::text NOT NULL,
    operator_id uuid,
    owner_is_primary_contact boolean DEFAULT true NOT NULL,
    tenant_is_primary_contact boolean DEFAULT false NOT NULL,
    operator_is_primary_contact boolean DEFAULT false NOT NULL,
    address text,
    notes text,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    whatsapp_profile_image_url text,
    whatsapp_profile_sync_status text,
    whatsapp_profile_last_synced_at timestamp with time zone,
    whatsapp_profile_sync_error text,
    last_whatsapp_sent_at timestamp with time zone,
    last_synced_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    apartment_size_sqm numeric(10,2),
    management_fee numeric(12,2),
    operator_name text,
    operator_phone text,
    unit_type text DEFAULT 'apartment'::text NOT NULL,
    source text,
    needs_review boolean DEFAULT false NOT NULL,
    CONSTRAINT contacts_resident_type_check CHECK ((resident_type = ANY (ARRAY['owner'::text, 'tenant'::text, 'operator'::text]))),
    CONSTRAINT contacts_source_check CHECK (((source IS NULL) OR (source = ANY (ARRAY['residents_import'::text, 'manual'::text, 'bllink_sync'::text, 'seed'::text])))),
    CONSTRAINT contacts_unit_type_check CHECK ((unit_type = ANY (ARRAY['apartment'::text, 'storage'::text, 'parking'::text, 'common'::text, 'staff'::text, 'other'::text]))),
    CONSTRAINT contacts_whatsapp_profile_sync_status_check CHECK ((whatsapp_profile_sync_status = ANY (ARRAY['pending'::text, 'synced'::text, 'no_avatar'::text, 'unavailable'::text, 'failed'::text])))
);


--
-- Name: COLUMN contacts.apartment_size_sqm; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contacts.apartment_size_sqm IS 'Apartment floor area in square metres (manual field, never written by an import).';


--
-- Name: COLUMN contacts.management_fee; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contacts.management_fee IS 'Agreed monthly management fee for the apartment (manual). NOT the synced debt in debtors.management_fees.';


--
-- Name: debtor_debt_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.debtor_debt_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    apartment_number text NOT NULL,
    total_debt numeric(12,2) DEFAULT 0 NOT NULL,
    snapshot_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: debtor_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.debtor_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    debtor_id uuid NOT NULL,
    event_type text NOT NULL,
    title text NOT NULL,
    description text,
    outcome text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    actor_id uuid,
    actor_name text,
    actor_email text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT debtor_events_event_type_check CHECK ((event_type = ANY (ARRAY['PHONE_CALL'::text, 'SMS'::text, 'WHATSAPP'::text, 'EMAIL'::text, 'MEETING'::text, 'ARCHIVE'::text, 'UNARCHIVE'::text, 'WARNING_LETTER'::text, 'LEGAL_PROCEEDING'::text, 'SYSTEM'::text, 'OTHER'::text])))
);


--
-- Name: debtors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.debtors (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    apartment_number text NOT NULL,
    owner_name text,
    tenant_name text,
    address text,
    phone_owner text,
    phone_tenant text,
    email_owner text,
    email_tenant text,
    phones_raw text,
    operator_id uuid,
    total_debt numeric(10,2) DEFAULT 0 NOT NULL,
    management_fees numeric(10,2) DEFAULT 0 NOT NULL,
    monthly_debt text,
    hot_water_debt numeric(10,2) DEFAULT 0 NOT NULL,
    special_debt numeric(10,2) DEFAULT 0 NOT NULL,
    details text,
    is_archived boolean DEFAULT false NOT NULL,
    last_imported_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    legal_status_id uuid,
    legal_status_source text DEFAULT 'MANUAL'::text,
    legal_status_lock boolean DEFAULT false NOT NULL,
    legal_status_updated_at timestamp with time zone,
    legal_status_updated_by uuid,
    legal_status_updated_by_name text,
    notes text,
    next_action_date date,
    next_action_description text,
    last_contact_date date,
    phones_manual_override boolean DEFAULT false NOT NULL,
    archived_at timestamp with time zone,
    last_whatsapp_sent_at timestamp with time zone,
    phone_owner_raw_backup text,
    phone_tenant_raw_backup text,
    contact_id uuid
);


--
-- Name: COLUMN debtors.phone_owner_raw_backup; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.debtors.phone_owner_raw_backup IS 'Pre-015 raw phone_owner snapshot (rollback source for the phone cleanup).';


--
-- Name: COLUMN debtors.phone_tenant_raw_backup; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.debtors.phone_tenant_raw_backup IS 'Pre-015 raw phone_tenant snapshot (rollback source for the phone cleanup).';


--
-- Name: document_folders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_folders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    parent_folder_id uuid,
    created_by uuid NOT NULL,
    is_archived boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    folder_id uuid,
    file_name text NOT NULL,
    storage_path text NOT NULL,
    mime_type text,
    size_bytes bigint,
    entity_type text,
    entity_id text,
    uploaded_by uuid NOT NULL,
    is_archived boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: entity_assignees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_assignees (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    assignee_type text NOT NULL,
    user_id uuid,
    supplier_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT entity_assignees_assignee_type_check CHECK ((assignee_type = ANY (ARRAY['user'::text, 'supplier'::text]))),
    CONSTRAINT entity_assignees_entity_type_check CHECK ((entity_type = ANY (ARRAY['task'::text, 'issue'::text]))),
    CONSTRAINT entity_assignees_one_target CHECK ((((assignee_type = 'user'::text) AND (user_id IS NOT NULL) AND (supplier_id IS NULL)) OR ((assignee_type = 'supplier'::text) AND (supplier_id IS NOT NULL) AND (user_id IS NULL))))
);


--
-- Name: import_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.import_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    mode text NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    total_rows integer DEFAULT 0 NOT NULL,
    processed_rows integer DEFAULT 0 NOT NULL,
    updated_rows integer DEFAULT 0 NOT NULL,
    created_rows integer DEFAULT 0 NOT NULL,
    skipped_rows integer DEFAULT 0 NOT NULL,
    error_message text,
    initiated_by uuid,
    kind text DEFAULT 'debtors'::text NOT NULL,
    file_name text,
    failed_rows integer DEFAULT 0 NOT NULL,
    error_details jsonb,
    error_summary text,
    CONSTRAINT import_runs_kind_check CHECK ((kind = ANY (ARRAY['debtors'::text, 'contacts'::text, 'residents'::text]))),
    CONSTRAINT import_runs_mode_check CHECK ((mode = ANY (ARRAY['merge'::text, 'replace'::text]))),
    CONSTRAINT import_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'success'::text, 'error'::text, 'parsing'::text, 'processing'::text, 'completed'::text, 'partial'::text, 'failed'::text])))
);


--
-- Name: internal_conversation_participants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.internal_conversation_participants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    user_id uuid NOT NULL,
    last_read_at timestamp with time zone DEFAULT now() NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: internal_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.internal_conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    type text DEFAULT 'direct'::text NOT NULL,
    name text,
    created_by uuid,
    created_by_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT internal_conversations_type_check CHECK ((type = ANY (ARRAY['direct'::text, 'group'::text])))
);


--
-- Name: internal_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.internal_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    sender_user_id uuid,
    sender_name text,
    content text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT internal_messages_content_check CHECK (((char_length(content) >= 1) AND (char_length(content) <= 4000)))
);


--
-- Name: issue_comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.issue_comments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    issue_id uuid NOT NULL,
    content text NOT NULL,
    author_id uuid,
    author_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: issues; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.issues (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    description text,
    location_type text DEFAULT 'general'::text NOT NULL,
    location_text text,
    priority text DEFAULT 'normal'::text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    assigned_to_user_id uuid,
    images text[] DEFAULT '{}'::text[] NOT NULL,
    resolution_notes text,
    resolved_at timestamp with time zone,
    is_archived boolean DEFAULT false NOT NULL,
    created_by uuid,
    created_by_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    target_type text,
    target_id uuid,
    supplier_id uuid,
    sort_order integer DEFAULT 0 NOT NULL,
    due_date date,
    due_time time without time zone,
    videos text[] DEFAULT '{}'::text[] NOT NULL,
    CONSTRAINT issues_location_type_check CHECK ((location_type = ANY (ARRAY['apartment'::text, 'area'::text, 'general'::text]))),
    CONSTRAINT issues_priority_check CHECK ((priority = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text, 'urgent'::text]))),
    CONSTRAINT issues_status_check CHECK ((status = ANY (ARRAY['open'::text, 'in_progress'::text, 'resolved'::text, 'closed'::text]))),
    CONSTRAINT issues_target_type_check CHECK ((target_type = ANY (ARRAY['room'::text, 'area'::text])))
);


--
-- Name: legal_status_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.legal_status_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    debtor_id uuid NOT NULL,
    apartment_number text NOT NULL,
    old_status_id uuid,
    old_status_name text,
    new_status_id uuid,
    new_status_name text,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    changed_by uuid,
    changed_by_name text,
    source text DEFAULT 'MANUAL'::text NOT NULL,
    notes text,
    CONSTRAINT legal_status_history_source_check CHECK ((source = ANY (ARRAY['MANUAL'::text, 'IMPORT'::text, 'AUTO_DEFAULT'::text, 'SYSTEM_FIX'::text])))
);


--
-- Name: monthly_collections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.monthly_collections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    year integer NOT NULL,
    month integer NOT NULL,
    collected_amount numeric(12,2) DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT monthly_collections_month_check CHECK (((month >= 1) AND (month <= 12)))
);


--
-- Name: monthly_debt_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.monthly_debt_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    snapshot_year integer NOT NULL,
    snapshot_month integer NOT NULL,
    snapshot_date date NOT NULL,
    total_debt numeric(12,2) DEFAULT 0 NOT NULL,
    management_debt numeric(12,2) DEFAULT 0 NOT NULL,
    water_debt numeric(12,2) DEFAULT 0 NOT NULL,
    special_debt numeric(12,2) DEFAULT 0 NOT NULL,
    debtor_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT monthly_debt_snapshots_snapshot_month_check CHECK (((snapshot_month >= 1) AND (snapshot_month <= 12)))
);


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    type text NOT NULL,
    title text NOT NULL,
    message text,
    is_read boolean DEFAULT false NOT NULL,
    source_module text,
    source_entity_type text,
    source_entity_id uuid,
    action_url text,
    priority text DEFAULT 'normal'::text NOT NULL,
    dedupe_key text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    read_at timestamp with time zone,
    cleared_at timestamp with time zone,
    CONSTRAINT notifications_priority_check CHECK ((priority = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text, 'urgent'::text])))
);


--
-- Name: parking_spots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.parking_spots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lot_code text DEFAULT '1P'::text NOT NULL,
    spot_number integer NOT NULL,
    size_type text DEFAULT 'single'::text NOT NULL,
    capacity integer GENERATED ALWAYS AS (
CASE
    WHEN (size_type = 'single'::text) THEN 1
    ELSE 2
END) STORED,
    owner_type text NOT NULL,
    apartment_number text,
    sale_status text DEFAULT 'none'::text NOT NULL,
    notes text,
    is_active boolean DEFAULT true NOT NULL,
    deactivated_at timestamp with time zone,
    deactivated_by uuid,
    deactivation_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_by uuid,
    CONSTRAINT parking_spots_apartment_link_check CHECK (((owner_type = 'apartment'::text) = (apartment_number IS NOT NULL))),
    CONSTRAINT parking_spots_deactivation_reason_required CHECK ((is_active OR (deactivation_reason IS NOT NULL))),
    CONSTRAINT parking_spots_owner_type_check CHECK ((owner_type = ANY (ARRAY['apartment'::text, 'developer'::text, 'committee'::text]))),
    CONSTRAINT parking_spots_sale_status_check CHECK ((sale_status = ANY (ARRAY['none'::text, 'for_sale'::text, 'in_process'::text, 'sold'::text]))),
    CONSTRAINT parking_spots_size_type_check CHECK ((size_type = ANY (ARRAY['single'::text, 'double_width'::text, 'double_length'::text])))
);


--
-- Name: password_reset_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.password_reset_tokens (
    token text NOT NULL,
    user_id uuid NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: reminder_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reminder_categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    color text NOT NULL,
    created_by uuid NOT NULL,
    display_order integer DEFAULT 0 NOT NULL,
    is_archived boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: reminders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reminders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    user_id uuid NOT NULL,
    remind_at timestamp with time zone NOT NULL,
    channel text DEFAULT 'both'::text NOT NULL,
    sent_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    channels text[],
    notify_owner boolean DEFAULT false NOT NULL,
    CONSTRAINT reminders_channel_check CHECK ((channel = ANY (ARRAY['in_app'::text, 'email'::text, 'both'::text, 'whatsapp'::text]))),
    CONSTRAINT reminders_channels_valid CHECK (((channels IS NULL) OR ((array_length(channels, 1) >= 1) AND (channels <@ ARRAY['in_app'::text, 'email'::text, 'whatsapp'::text]))))
);


--
-- Name: COLUMN reminders.notify_owner; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.reminders.notify_owner IS 'When true, the reminder engine also notifies the row owner (user_id) — the "אליי"/self opt-in — in addition to the entity assignees.';


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version character varying NOT NULL
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id text NOT NULL,
    user_id uuid NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    remember boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: statuses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.statuses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    color text DEFAULT '#e5e7eb'::text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    notification_emails text[],
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_system boolean DEFAULT false NOT NULL,
    created_by uuid,
    updated_by uuid,
    CONSTRAINT statuses_color_format CHECK ((color ~ '^#[0-9a-fA-F]{6}$'::text))
);


--
-- Name: storage_units; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.storage_units (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    unit_number text NOT NULL,
    owner_type text NOT NULL,
    apartment_number text,
    notes text,
    is_active boolean DEFAULT true NOT NULL,
    deactivated_at timestamp with time zone,
    deactivated_by uuid,
    deactivation_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_by uuid,
    CONSTRAINT storage_units_apartment_link_check CHECK (((owner_type = 'apartment'::text) = (apartment_number IS NOT NULL))),
    CONSTRAINT storage_units_deactivation_reason_required CHECK ((is_active OR (deactivation_reason IS NOT NULL))),
    CONSTRAINT storage_units_owner_type_check CHECK ((owner_type = ANY (ARRAY['apartment'::text, 'developer'::text, 'committee'::text])))
);


--
-- Name: supplier_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supplier_categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    color text
);


--
-- Name: supplier_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supplier_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    supplier_id uuid NOT NULL,
    file_name text NOT NULL,
    file_url text NOT NULL,
    file_size_bytes integer DEFAULT 0 NOT NULL,
    mime_type text DEFAULT ''::text NOT NULL,
    doc_type text DEFAULT 'general'::text NOT NULL,
    uploaded_by uuid,
    uploaded_by_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: suppliers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.suppliers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    display_name text NOT NULL,
    company_name text DEFAULT ''::text NOT NULL,
    contact_person text DEFAULT ''::text NOT NULL,
    supplier_type text DEFAULT 'general'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    phone text DEFAULT ''::text NOT NULL,
    mobile text DEFAULT ''::text NOT NULL,
    email text DEFAULT ''::text NOT NULL,
    website text DEFAULT ''::text NOT NULL,
    address text DEFAULT ''::text NOT NULL,
    city text DEFAULT ''::text NOT NULL,
    tax_id text DEFAULT ''::text NOT NULL,
    bank_name text DEFAULT ''::text NOT NULL,
    bank_branch text DEFAULT ''::text NOT NULL,
    bank_account text DEFAULT ''::text NOT NULL,
    payment_terms text DEFAULT 'net_30'::text NOT NULL,
    notes text DEFAULT ''::text NOT NULL,
    internal_notes text DEFAULT ''::text NOT NULL,
    rating integer,
    created_by uuid,
    created_by_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    category_id uuid,
    CONSTRAINT suppliers_payment_terms_check CHECK ((payment_terms = ANY (ARRAY['immediate'::text, 'net_15'::text, 'net_30'::text, 'net_45'::text, 'net_60'::text, 'net_90'::text, 'other'::text]))),
    CONSTRAINT suppliers_status_check CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text])))
);


--
-- Name: sync_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sync_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    status text DEFAULT 'running'::text NOT NULL,
    error_message text,
    triggered_by uuid,
    CONSTRAINT sync_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'success'::text, 'error'::text])))
);


--
-- Name: task_comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_comments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    task_id uuid NOT NULL,
    content text NOT NULL,
    author_id uuid,
    author_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: task_occurrence_completions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_occurrence_completions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    task_id uuid NOT NULL,
    recurrence_id uuid,
    occurrence_date date NOT NULL,
    completed_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_by uuid,
    completed_by_name text
);


--
-- Name: task_recurrence_exceptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_recurrence_exceptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    recurrence_id uuid NOT NULL,
    excluded_date date NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: task_recurrences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_recurrences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    task_id uuid NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    frequency text NOT NULL,
    "interval" integer DEFAULT 1 NOT NULL,
    byweekday integer[],
    end_type text DEFAULT 'never'::text NOT NULL,
    end_date date,
    end_count integer,
    last_spawned_at timestamp with time zone,
    spawned_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    anchor_date date NOT NULL,
    CONSTRAINT task_recurrences_end_count_check CHECK (((end_count IS NULL) OR (end_count >= 1))),
    CONSTRAINT task_recurrences_end_type_check CHECK ((end_type = ANY (ARRAY['never'::text, 'on_date'::text, 'after_count'::text]))),
    CONSTRAINT task_recurrences_frequency_check CHECK ((frequency = ANY (ARRAY['daily'::text, 'weekly'::text, 'monthly'::text, 'yearly'::text]))),
    CONSTRAINT task_recurrences_interval_check CHECK (("interval" >= 1))
);


--
-- Name: COLUMN task_recurrences.last_spawned_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.task_recurrences.last_spawned_at IS 'FROZEN (migration 067): the materializer is gone.';


--
-- Name: COLUMN task_recurrences.spawned_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.task_recurrences.spawned_count IS 'FROZEN (migration 067): the materializer is gone.';


--
-- Name: COLUMN task_recurrences.anchor_date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.task_recurrences.anchor_date IS 'Series origin (immutable). interval / after_count are measured from here, so advancing tasks.due_date never re-phases the series.';


--
-- Name: tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    description text,
    status text DEFAULT 'open'::text NOT NULL,
    priority text DEFAULT 'normal'::text NOT NULL,
    due_date date,
    due_time time without time zone,
    assigned_to_user_id uuid,
    debtor_id uuid,
    apartment_number text,
    sort_order integer DEFAULT 0 NOT NULL,
    is_archived boolean DEFAULT false NOT NULL,
    created_by uuid,
    created_by_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    issue_id uuid,
    completed_at timestamp with time zone,
    related_entity_type text,
    related_entity_id uuid,
    target_type text,
    target_id uuid,
    supplier_id uuid,
    recurrence_id uuid,
    is_recurring_template boolean DEFAULT false NOT NULL,
    is_recurring_instance boolean DEFAULT false NOT NULL,
    parent_task_id uuid,
    occurrence_date date,
    CONSTRAINT tasks_priority_check CHECK ((priority = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text, 'urgent'::text]))),
    CONSTRAINT tasks_related_entity_type_check CHECK ((related_entity_type = ANY (ARRAY['debtor'::text, 'building'::text, 'supplier'::text, 'contact'::text]))),
    CONSTRAINT tasks_status_check CHECK ((status = ANY (ARRAY['open'::text, 'in_progress'::text, 'done'::text, 'cancelled'::text]))),
    CONSTRAINT tasks_target_type_check CHECK ((target_type = ANY (ARRAY['room'::text, 'area'::text])))
);


--
-- Name: COLUMN tasks.is_recurring_instance; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tasks.is_recurring_instance IS 'FROZEN (migration 067): always false — there are no materialized instances any more.';


--
-- Name: COLUMN tasks.parent_task_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tasks.parent_task_id IS 'FROZEN (migration 067): instances no longer exist, so nothing points at a parent task.';


--
-- Name: COLUMN tasks.occurrence_date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tasks.occurrence_date IS 'FROZEN (migration 067): superseded by the single-row model — due_date is the current occurrence.';


--
-- Name: user_invites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_invites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    full_name text NOT NULL,
    role text NOT NULL,
    token text NOT NULL,
    invited_by uuid NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    custom_permissions jsonb,
    CONSTRAINT user_invites_role_check CHECK ((role = ANY (ARRAY['super_admin'::text, 'admin'::text, 'manager'::text, 'viewer'::text, 'cleaner'::text, 'maintenance'::text])))
);


--
-- Name: user_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_permissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    module text NOT NULL,
    can_view boolean DEFAULT false NOT NULL,
    can_edit boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_reminders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_reminders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    remind_at timestamp with time zone NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    entity_type text,
    entity_id text,
    assigned_to uuid,
    created_by uuid NOT NULL,
    completed_at timestamp with time zone,
    is_archived boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    category_id uuid,
    CONSTRAINT user_reminders_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'done'::text, 'dismissed'::text])))
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    username text NOT NULL,
    email text NOT NULL,
    password_hash text NOT NULL,
    full_name text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    role text DEFAULT 'viewer'::text NOT NULL,
    notification_phone text,
    notify_email boolean DEFAULT true NOT NULL,
    notify_whatsapp boolean DEFAULT false NOT NULL,
    allow_google_auth boolean DEFAULT false NOT NULL,
    last_seen_at timestamp with time zone,
    CONSTRAINT users_role_check CHECK ((role = ANY (ARRAY['super_admin'::text, 'admin'::text, 'manager'::text, 'viewer'::text, 'cleaner'::text, 'maintenance'::text])))
);


--
-- Name: COLUMN users.last_seen_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.last_seen_at IS 'Last realtime-chat heartbeat (SSE connect/heartbeat). Drives the online dot: online = now() - last_seen_at < 60s.';


--
-- Name: wa_campaign_recipients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wa_campaign_recipients (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    campaign_id uuid NOT NULL,
    debtor_id uuid,
    phone_intl text NOT NULL,
    chat_id text NOT NULL,
    payload text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 5 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    worker_id text,
    processing_started_at timestamp with time zone,
    lease_expires_at timestamp with time zone,
    send_attempted_at timestamp with time zone,
    sent_at timestamp with time zone,
    failed_at timestamp with time zone,
    delivered_at timestamp with time zone,
    read_at timestamp with time zone,
    provider_message_id text,
    last_error text,
    error_class text,
    idempotency_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT wa_campaign_recipients_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'sent'::text, 'failed'::text, 'skipped'::text, 'cancelled'::text])))
);


--
-- Name: wa_campaigns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wa_campaigns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    type text DEFAULT 'broadcast'::text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    name text NOT NULL,
    body text NOT NULL,
    template_name text,
    audience jsonb DEFAULT '{}'::jsonb NOT NULL,
    instance_id uuid,
    created_by uuid,
    total_count integer DEFAULT 0 NOT NULL,
    pending_count integer DEFAULT 0 NOT NULL,
    processing_count integer DEFAULT 0 NOT NULL,
    sent_count integer DEFAULT 0 NOT NULL,
    failed_count integer DEFAULT 0 NOT NULL,
    skipped_count integer DEFAULT 0 NOT NULL,
    cancelled_count integer DEFAULT 0 NOT NULL,
    rate_per_min integer DEFAULT 12 NOT NULL,
    dry_run boolean DEFAULT false NOT NULL,
    client_token text,
    scheduled_at timestamp with time zone,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    paused_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT wa_campaigns_rate_per_min_check CHECK (((rate_per_min >= 1) AND (rate_per_min <= 120))),
    CONSTRAINT wa_campaigns_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'queued'::text, 'running'::text, 'paused'::text, 'completed'::text, 'completed_with_errors'::text, 'cancelled'::text, 'failed'::text]))),
    CONSTRAINT wa_campaigns_type_check CHECK ((type = 'broadcast'::text))
);


--
-- Name: wa_send_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wa_send_log (
    id bigint NOT NULL,
    bucket text NOT NULL,
    sent_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: wa_send_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.wa_send_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: wa_send_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.wa_send_log_id_seq OWNED BY public.wa_send_log.id;


--
-- Name: wa_worker_heartbeat; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wa_worker_heartbeat (
    worker_id text NOT NULL,
    last_beat_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: whatsapp_avatars; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_avatars (
    chat_id text NOT NULL,
    avatar_url text,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: whatsapp_broadcasts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_broadcasts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    body text NOT NULL,
    audience_filter jsonb DEFAULT '{}'::jsonb NOT NULL,
    total_count integer DEFAULT 0 NOT NULL,
    sent_count integer DEFAULT 0 NOT NULL,
    failed_count integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    instance_id uuid,
    CONSTRAINT whatsapp_broadcasts_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'completed'::text, 'failed'::text])))
);


--
-- Name: whatsapp_instances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_instances (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    display_name text NOT NULL,
    green_instance_id text NOT NULL,
    green_token_enc jsonb NOT NULL,
    api_url text DEFAULT 'https://api.green-api.com'::text NOT NULL,
    state text DEFAULT 'notAuthorized'::text NOT NULL,
    state_checked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT whatsapp_instances_state_check CHECK ((state = ANY (ARRAY['notAuthorized'::text, 'authorized'::text, 'blocked'::text, 'starting'::text, 'yellowCard'::text, 'sleepMode'::text])))
);


--
-- Name: COLUMN whatsapp_instances.user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.whatsapp_instances.user_id IS 'Nominal technical owner: webhook routing + legacy instance association ONLY. NOT an authorization boundary — never use it to decide who may view chats, send messages, pull messages, or run campaigns. Access is controlled exclusively by the whatsapp_chat permission; the instance is shared between all authorized users. Tech debt: rename to webhook_owner_user_id.';


--
-- Name: whatsapp_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    content text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: wa_send_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wa_send_log ALTER COLUMN id SET DEFAULT nextval('public.wa_send_log_id_seq'::regclass);


--
-- Name: app_settings app_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_settings
    ADD CONSTRAINT app_settings_pkey PRIMARY KEY (key);


--
-- Name: areas areas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.areas
    ADD CONSTRAINT areas_pkey PRIMARY KEY (id);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: auth_rate_limits auth_rate_limits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_rate_limits
    ADD CONSTRAINT auth_rate_limits_pkey PRIMARY KEY (id);


--
-- Name: calendar_event_participants calendar_event_participants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_event_participants
    ADD CONSTRAINT calendar_event_participants_pkey PRIMARY KEY (id);


--
-- Name: calendar_events calendar_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_events
    ADD CONSTRAINT calendar_events_pkey PRIMARY KEY (id);


--
-- Name: chat_messages chat_messages_external_message_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_external_message_id_key UNIQUE (external_message_id);


--
-- Name: chat_messages chat_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_pkey PRIMARY KEY (id);


--
-- Name: chip_events chip_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chip_events
    ADD CONSTRAINT chip_events_pkey PRIMARY KEY (id);


--
-- Name: chips chips_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chips
    ADD CONSTRAINT chips_pkey PRIMARY KEY (id);


--
-- Name: comments comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_pkey PRIMARY KEY (id);


--
-- Name: completed_actions completed_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.completed_actions
    ADD CONSTRAINT completed_actions_pkey PRIMARY KEY (id);


--
-- Name: contact_people contact_people_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_people
    ADD CONSTRAINT contact_people_pkey PRIMARY KEY (id);


--
-- Name: contacts contacts_apartment_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_apartment_number_key UNIQUE (apartment_number);


--
-- Name: contacts contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_pkey PRIMARY KEY (id);


--
-- Name: debtor_debt_snapshots debtor_debt_snapshots_apartment_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.debtor_debt_snapshots
    ADD CONSTRAINT debtor_debt_snapshots_apartment_number_key UNIQUE (apartment_number);


--
-- Name: debtor_debt_snapshots debtor_debt_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.debtor_debt_snapshots
    ADD CONSTRAINT debtor_debt_snapshots_pkey PRIMARY KEY (id);


--
-- Name: debtor_events debtor_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.debtor_events
    ADD CONSTRAINT debtor_events_pkey PRIMARY KEY (id);


--
-- Name: debtors debtors_apartment_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.debtors
    ADD CONSTRAINT debtors_apartment_number_key UNIQUE (apartment_number);


--
-- Name: debtors debtors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.debtors
    ADD CONSTRAINT debtors_pkey PRIMARY KEY (id);


--
-- Name: document_folders document_folders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_folders
    ADD CONSTRAINT document_folders_pkey PRIMARY KEY (id);


--
-- Name: documents documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_pkey PRIMARY KEY (id);


--
-- Name: entity_assignees entity_assignees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_assignees
    ADD CONSTRAINT entity_assignees_pkey PRIMARY KEY (id);


--
-- Name: import_runs import_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_runs
    ADD CONSTRAINT import_runs_pkey PRIMARY KEY (id);


--
-- Name: internal_conversation_participants internal_conversation_participants_conversation_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internal_conversation_participants
    ADD CONSTRAINT internal_conversation_participants_conversation_id_user_id_key UNIQUE (conversation_id, user_id);


--
-- Name: internal_conversation_participants internal_conversation_participants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internal_conversation_participants
    ADD CONSTRAINT internal_conversation_participants_pkey PRIMARY KEY (id);


--
-- Name: internal_conversations internal_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internal_conversations
    ADD CONSTRAINT internal_conversations_pkey PRIMARY KEY (id);


--
-- Name: internal_messages internal_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internal_messages
    ADD CONSTRAINT internal_messages_pkey PRIMARY KEY (id);


--
-- Name: issue_comments issue_comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issue_comments
    ADD CONSTRAINT issue_comments_pkey PRIMARY KEY (id);


--
-- Name: issues issues_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issues
    ADD CONSTRAINT issues_pkey PRIMARY KEY (id);


--
-- Name: legal_status_history legal_status_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legal_status_history
    ADD CONSTRAINT legal_status_history_pkey PRIMARY KEY (id);


--
-- Name: monthly_collections monthly_collections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monthly_collections
    ADD CONSTRAINT monthly_collections_pkey PRIMARY KEY (id);


--
-- Name: monthly_debt_snapshots monthly_debt_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monthly_debt_snapshots
    ADD CONSTRAINT monthly_debt_snapshots_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: parking_spots parking_spots_lot_spot_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parking_spots
    ADD CONSTRAINT parking_spots_lot_spot_uniq UNIQUE (lot_code, spot_number);


--
-- Name: parking_spots parking_spots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parking_spots
    ADD CONSTRAINT parking_spots_pkey PRIMARY KEY (id);


--
-- Name: password_reset_tokens password_reset_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_pkey PRIMARY KEY (token);


--
-- Name: reminder_categories reminder_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reminder_categories
    ADD CONSTRAINT reminder_categories_pkey PRIMARY KEY (id);


--
-- Name: reminders reminders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reminders
    ADD CONSTRAINT reminders_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: statuses statuses_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statuses
    ADD CONSTRAINT statuses_name_key UNIQUE (name);


--
-- Name: statuses statuses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statuses
    ADD CONSTRAINT statuses_pkey PRIMARY KEY (id);


--
-- Name: storage_units storage_units_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_units
    ADD CONSTRAINT storage_units_pkey PRIMARY KEY (id);


--
-- Name: supplier_categories supplier_categories_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_categories
    ADD CONSTRAINT supplier_categories_name_key UNIQUE (name);


--
-- Name: supplier_categories supplier_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_categories
    ADD CONSTRAINT supplier_categories_pkey PRIMARY KEY (id);


--
-- Name: supplier_documents supplier_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_documents
    ADD CONSTRAINT supplier_documents_pkey PRIMARY KEY (id);


--
-- Name: suppliers suppliers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suppliers
    ADD CONSTRAINT suppliers_pkey PRIMARY KEY (id);


--
-- Name: sync_runs sync_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_runs
    ADD CONSTRAINT sync_runs_pkey PRIMARY KEY (id);


--
-- Name: task_comments task_comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_comments
    ADD CONSTRAINT task_comments_pkey PRIMARY KEY (id);


--
-- Name: task_occurrence_completions task_occurrence_completions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_occurrence_completions
    ADD CONSTRAINT task_occurrence_completions_pkey PRIMARY KEY (id);


--
-- Name: task_occurrence_completions task_occurrence_completions_task_id_occurrence_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_occurrence_completions
    ADD CONSTRAINT task_occurrence_completions_task_id_occurrence_date_key UNIQUE (task_id, occurrence_date);


--
-- Name: task_recurrence_exceptions task_recurrence_exceptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_recurrence_exceptions
    ADD CONSTRAINT task_recurrence_exceptions_pkey PRIMARY KEY (id);


--
-- Name: task_recurrence_exceptions task_recurrence_exceptions_recurrence_id_excluded_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_recurrence_exceptions
    ADD CONSTRAINT task_recurrence_exceptions_recurrence_id_excluded_date_key UNIQUE (recurrence_id, excluded_date);


--
-- Name: task_recurrences task_recurrences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_recurrences
    ADD CONSTRAINT task_recurrences_pkey PRIMARY KEY (id);


--
-- Name: tasks tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);


--
-- Name: user_invites user_invites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_invites
    ADD CONSTRAINT user_invites_pkey PRIMARY KEY (id);


--
-- Name: user_invites user_invites_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_invites
    ADD CONSTRAINT user_invites_token_key UNIQUE (token);


--
-- Name: user_permissions user_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_permissions
    ADD CONSTRAINT user_permissions_pkey PRIMARY KEY (id);


--
-- Name: user_permissions user_permissions_user_id_module_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_permissions
    ADD CONSTRAINT user_permissions_user_id_module_key UNIQUE (user_id, module);


--
-- Name: user_reminders user_reminders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_reminders
    ADD CONSTRAINT user_reminders_pkey PRIMARY KEY (id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key UNIQUE (username);


--
-- Name: wa_campaign_recipients wa_campaign_recipients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wa_campaign_recipients
    ADD CONSTRAINT wa_campaign_recipients_pkey PRIMARY KEY (id);


--
-- Name: wa_campaigns wa_campaigns_client_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wa_campaigns
    ADD CONSTRAINT wa_campaigns_client_token_key UNIQUE (client_token);


--
-- Name: wa_campaigns wa_campaigns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wa_campaigns
    ADD CONSTRAINT wa_campaigns_pkey PRIMARY KEY (id);


--
-- Name: wa_send_log wa_send_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wa_send_log
    ADD CONSTRAINT wa_send_log_pkey PRIMARY KEY (id);


--
-- Name: wa_worker_heartbeat wa_worker_heartbeat_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wa_worker_heartbeat
    ADD CONSTRAINT wa_worker_heartbeat_pkey PRIMARY KEY (worker_id);


--
-- Name: whatsapp_avatars whatsapp_avatars_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_avatars
    ADD CONSTRAINT whatsapp_avatars_pkey PRIMARY KEY (chat_id);


--
-- Name: whatsapp_broadcasts whatsapp_broadcasts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_broadcasts
    ADD CONSTRAINT whatsapp_broadcasts_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_instances whatsapp_instances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_instances
    ADD CONSTRAINT whatsapp_instances_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_instances whatsapp_instances_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_instances
    ADD CONSTRAINT whatsapp_instances_user_id_key UNIQUE (user_id);


--
-- Name: whatsapp_templates whatsapp_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_templates
    ADD CONSTRAINT whatsapp_templates_pkey PRIMARY KEY (id);


--
-- Name: audit_log_actor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_actor_idx ON public.audit_log USING btree (actor_user_id);


--
-- Name: audit_log_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_created_idx ON public.audit_log USING btree (created_at DESC);


--
-- Name: audit_log_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_entity_idx ON public.audit_log USING btree (entity_type, entity_id);


--
-- Name: auth_rate_limits_bucket_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_rate_limits_bucket_time_idx ON public.auth_rate_limits USING btree (bucket, hit_at);


--
-- Name: calendar_event_participants_event_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX calendar_event_participants_event_idx ON public.calendar_event_participants USING btree (event_id);


--
-- Name: calendar_event_participants_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX calendar_event_participants_uniq ON public.calendar_event_participants USING btree (event_id, participant_source, participant_id);


--
-- Name: calendar_events_event_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX calendar_events_event_date_idx ON public.calendar_events USING btree (event_date);


--
-- Name: calendar_events_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX calendar_events_owner_idx ON public.calendar_events USING btree (owner_user_id);


--
-- Name: calendar_events_parent_series_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX calendar_events_parent_series_idx ON public.calendar_events USING btree (parent_series_id);


--
-- Name: chat_messages_broadcast_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_messages_broadcast_idx ON public.chat_messages USING btree (broadcast_id);


--
-- Name: chat_messages_chat_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_messages_chat_id_idx ON public.chat_messages USING btree (chat_id);


--
-- Name: chat_messages_debtor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_messages_debtor_idx ON public.chat_messages USING btree (debtor_id, created_at DESC);


--
-- Name: chat_messages_external_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_messages_external_id_idx ON public.chat_messages USING btree (external_message_id);


--
-- Name: chat_messages_instance_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_messages_instance_idx ON public.chat_messages USING btree (instance_id, chat_id);


--
-- Name: chip_events_chip_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chip_events_chip_idx ON public.chip_events USING btree (chip_id, created_at DESC);


--
-- Name: chips_apartment_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chips_apartment_trgm_idx ON public.chips USING gin (apartment_number public.gin_trgm_ops);


--
-- Name: chips_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chips_contact_idx ON public.chips USING btree (contact_id);


--
-- Name: chips_holder_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chips_holder_idx ON public.chips USING btree (contact_id, resident_role, status);


--
-- Name: chips_holder_name_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chips_holder_name_trgm_idx ON public.chips USING gin (holder_name public.gin_trgm_ops);


--
-- Name: chips_number_active_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX chips_number_active_uniq ON public.chips USING btree (chip_number) WHERE (status = 'active'::text);


--
-- Name: chips_number_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chips_number_idx ON public.chips USING btree (chip_number);


--
-- Name: chips_number_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chips_number_trgm_idx ON public.chips USING gin (chip_number public.gin_trgm_ops);


--
-- Name: chips_pending_sync; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chips_pending_sync ON public.chips USING btree (id) WHERE ((status = 'inactive'::text) AND (controller_synced = false));


--
-- Name: chips_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chips_status_idx ON public.chips USING btree (status);


--
-- Name: chips_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chips_type_idx ON public.chips USING btree (chip_type);


--
-- Name: comments_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX comments_created_at_idx ON public.comments USING btree (created_at DESC);


--
-- Name: comments_debtor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX comments_debtor_idx ON public.comments USING btree (debtor_id);


--
-- Name: completed_actions_completed_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX completed_actions_completed_at_idx ON public.completed_actions USING btree (completed_at DESC);


--
-- Name: completed_actions_debtor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX completed_actions_debtor_idx ON public.completed_actions USING btree (debtor_id);


--
-- Name: contact_people_contact_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contact_people_contact_id_idx ON public.contact_people USING btree (contact_id, role, sort_order);


--
-- Name: contact_people_recipients_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contact_people_recipients_idx ON public.contact_people USING btree (contact_id) WHERE (is_primary_contact AND (phone IS NOT NULL));


--
-- Name: contacts_operator_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contacts_operator_id_idx ON public.contacts USING btree (operator_id);


--
-- Name: contacts_operator_name_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contacts_operator_name_trgm_idx ON public.contacts USING gin (operator_name public.gin_trgm_ops);


--
-- Name: contacts_owner_name_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contacts_owner_name_trgm_idx ON public.contacts USING gin (owner_name public.gin_trgm_ops);


--
-- Name: contacts_tags_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contacts_tags_idx ON public.contacts USING gin (tags);


--
-- Name: contacts_tenant_name_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contacts_tenant_name_trgm_idx ON public.contacts USING gin (tenant_name public.gin_trgm_ops);


--
-- Name: debtor_events_debtor_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX debtor_events_debtor_created_idx ON public.debtor_events USING btree (debtor_id, created_at DESC);


--
-- Name: debtor_events_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX debtor_events_type_idx ON public.debtor_events USING btree (event_type);


--
-- Name: debtors_apt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX debtors_apt_idx ON public.debtors USING btree (apartment_number);


--
-- Name: debtors_contact_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX debtors_contact_id_idx ON public.debtors USING btree (contact_id);


--
-- Name: debtors_is_archived_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX debtors_is_archived_idx ON public.debtors USING btree (is_archived);


--
-- Name: debtors_legal_status_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX debtors_legal_status_id_idx ON public.debtors USING btree (legal_status_id);


--
-- Name: document_folders_created_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_folders_created_by_idx ON public.document_folders USING btree (created_by);


--
-- Name: document_folders_parent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_folders_parent_idx ON public.document_folders USING btree (parent_folder_id);


--
-- Name: documents_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX documents_entity_idx ON public.documents USING btree (entity_type, entity_id);


--
-- Name: documents_folder_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX documents_folder_idx ON public.documents USING btree (folder_id);


--
-- Name: documents_uploaded_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX documents_uploaded_by_idx ON public.documents USING btree (uploaded_by);


--
-- Name: entity_assignees_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_assignees_entity_idx ON public.entity_assignees USING btree (entity_type, entity_id);


--
-- Name: entity_assignees_supplier_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_assignees_supplier_idx ON public.entity_assignees USING btree (supplier_id) WHERE (supplier_id IS NOT NULL);


--
-- Name: entity_assignees_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX entity_assignees_uniq ON public.entity_assignees USING btree (entity_type, entity_id, assignee_type, COALESCE(user_id, supplier_id));


--
-- Name: entity_assignees_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_assignees_user_idx ON public.entity_assignees USING btree (user_id) WHERE (user_id IS NOT NULL);


--
-- Name: idx_chat_messages_supplier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_messages_supplier ON public.chat_messages USING btree (supplier_id);


--
-- Name: idx_import_runs_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_import_runs_kind ON public.import_runs USING btree (kind);


--
-- Name: idx_issues_supplier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_issues_supplier ON public.issues USING btree (supplier_id);


--
-- Name: idx_issues_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_issues_target ON public.issues USING btree (target_type, target_id) WHERE (target_id IS NOT NULL);


--
-- Name: idx_supplier_docs_supplier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_supplier_docs_supplier ON public.supplier_documents USING btree (supplier_id);


--
-- Name: idx_suppliers_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_suppliers_category ON public.suppliers USING btree (category_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_suppliers_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_suppliers_status ON public.suppliers USING btree (status) WHERE (deleted_at IS NULL);


--
-- Name: idx_suppliers_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_suppliers_type ON public.suppliers USING btree (supplier_type) WHERE (deleted_at IS NULL);


--
-- Name: idx_tasks_supplier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_supplier ON public.tasks USING btree (supplier_id);


--
-- Name: idx_tasks_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_target ON public.tasks USING btree (target_type, target_id) WHERE (target_id IS NOT NULL);


--
-- Name: idx_user_invites_email_lower; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_invites_email_lower ON public.user_invites USING btree (lower(email));


--
-- Name: idx_user_invites_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_invites_token ON public.user_invites USING btree (token);


--
-- Name: idx_user_permissions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_permissions_user ON public.user_permissions USING btree (user_id);


--
-- Name: import_runs_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX import_runs_started_idx ON public.import_runs USING btree (started_at DESC);


--
-- Name: import_runs_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX import_runs_status_idx ON public.import_runs USING btree (status);


--
-- Name: internal_conversations_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX internal_conversations_type_idx ON public.internal_conversations USING btree (type);


--
-- Name: internal_conversations_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX internal_conversations_updated_idx ON public.internal_conversations USING btree (updated_at DESC);


--
-- Name: internal_messages_conversation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX internal_messages_conversation_idx ON public.internal_messages USING btree (conversation_id, created_at);


--
-- Name: internal_participants_conversation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX internal_participants_conversation_idx ON public.internal_conversation_participants USING btree (conversation_id);


--
-- Name: internal_participants_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX internal_participants_user_idx ON public.internal_conversation_participants USING btree (user_id);


--
-- Name: issue_comments_issue_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX issue_comments_issue_id_idx ON public.issue_comments USING btree (issue_id, created_at);


--
-- Name: issues_assigned_to_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX issues_assigned_to_idx ON public.issues USING btree (assigned_to_user_id);


--
-- Name: issues_due_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX issues_due_date_idx ON public.issues USING btree (due_date) WHERE (due_date IS NOT NULL);


--
-- Name: issues_priority_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX issues_priority_idx ON public.issues USING btree (priority);


--
-- Name: issues_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX issues_status_idx ON public.issues USING btree (status);


--
-- Name: issues_status_sort_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX issues_status_sort_idx ON public.issues USING btree (status, sort_order);


--
-- Name: legal_status_history_changed_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX legal_status_history_changed_at_idx ON public.legal_status_history USING btree (changed_at DESC);


--
-- Name: legal_status_history_debtor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX legal_status_history_debtor_idx ON public.legal_status_history USING btree (debtor_id);


--
-- Name: monthly_collections_ym_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX monthly_collections_ym_idx ON public.monthly_collections USING btree (year, month);


--
-- Name: monthly_debt_snapshots_ym_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX monthly_debt_snapshots_ym_idx ON public.monthly_debt_snapshots USING btree (snapshot_year, snapshot_month);


--
-- Name: notifications_dedupe_key_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX notifications_dedupe_key_uidx ON public.notifications USING btree (dedupe_key) WHERE (dedupe_key IS NOT NULL);


--
-- Name: notifications_user_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_user_active_idx ON public.notifications USING btree (user_id, is_read, created_at DESC) WHERE (cleared_at IS NULL);


--
-- Name: notifications_user_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_user_created_idx ON public.notifications USING btree (user_id, created_at DESC);


--
-- Name: notifications_user_read_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_user_read_idx ON public.notifications USING btree (user_id, is_read);


--
-- Name: notifications_user_unread_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_user_unread_idx ON public.notifications USING btree (user_id, is_read, created_at DESC);


--
-- Name: parking_spots_apartment_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX parking_spots_apartment_idx ON public.parking_spots USING btree (apartment_number) WHERE (apartment_number IS NOT NULL);


--
-- Name: parking_spots_owner_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX parking_spots_owner_type_idx ON public.parking_spots USING btree (owner_type);


--
-- Name: password_reset_tokens_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX password_reset_tokens_user_idx ON public.password_reset_tokens USING btree (user_id);


--
-- Name: reminder_categories_created_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reminder_categories_created_by_idx ON public.reminder_categories USING btree (created_by);


--
-- Name: reminder_categories_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reminder_categories_order_idx ON public.reminder_categories USING btree (display_order, name);


--
-- Name: reminders_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reminders_due_idx ON public.reminders USING btree (remind_at) WHERE (sent_at IS NULL);


--
-- Name: reminders_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reminders_entity_idx ON public.reminders USING btree (entity_type, entity_id);


--
-- Name: sessions_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_expires_idx ON public.sessions USING btree (expires_at);


--
-- Name: sessions_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_user_idx ON public.sessions USING btree (user_id);


--
-- Name: statuses_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX statuses_active_idx ON public.statuses USING btree (is_active);


--
-- Name: statuses_one_default_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX statuses_one_default_idx ON public.statuses USING btree (is_default) WHERE (is_default = true);


--
-- Name: statuses_sort_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX statuses_sort_idx ON public.statuses USING btree (sort_order);


--
-- Name: storage_units_apartment_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX storage_units_apartment_idx ON public.storage_units USING btree (apartment_number) WHERE (apartment_number IS NOT NULL);


--
-- Name: storage_units_number_active_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX storage_units_number_active_uniq ON public.storage_units USING btree (unit_number) WHERE is_active;


--
-- Name: storage_units_owner_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX storage_units_owner_type_idx ON public.storage_units USING btree (owner_type);


--
-- Name: sync_runs_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sync_runs_started_idx ON public.sync_runs USING btree (started_at DESC);


--
-- Name: task_comments_task_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX task_comments_task_id_idx ON public.task_comments USING btree (task_id, created_at);


--
-- Name: task_occurrence_completions_recurrence_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX task_occurrence_completions_recurrence_idx ON public.task_occurrence_completions USING btree (recurrence_id);


--
-- Name: task_occurrence_completions_task_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX task_occurrence_completions_task_date_idx ON public.task_occurrence_completions USING btree (task_id, occurrence_date DESC);


--
-- Name: task_recurrence_exceptions_recurrence_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX task_recurrence_exceptions_recurrence_id_idx ON public.task_recurrence_exceptions USING btree (recurrence_id);


--
-- Name: task_recurrences_task_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX task_recurrences_task_uniq ON public.task_recurrences USING btree (task_id);


--
-- Name: tasks_assigned_to_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_assigned_to_idx ON public.tasks USING btree (assigned_to_user_id);


--
-- Name: tasks_due_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_due_date_idx ON public.tasks USING btree (due_date);


--
-- Name: tasks_is_recurring_template_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_is_recurring_template_idx ON public.tasks USING btree (is_recurring_template) WHERE is_recurring_template;


--
-- Name: tasks_issue_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_issue_id_idx ON public.tasks USING btree (issue_id);


--
-- Name: tasks_recurrence_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_recurrence_id_idx ON public.tasks USING btree (recurrence_id);


--
-- Name: tasks_recurrence_single_row_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX tasks_recurrence_single_row_uniq ON public.tasks USING btree (recurrence_id) WHERE (recurrence_id IS NOT NULL);


--
-- Name: tasks_related_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_related_entity_idx ON public.tasks USING btree (related_entity_type, related_entity_id);


--
-- Name: tasks_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_status_idx ON public.tasks USING btree (status);


--
-- Name: tasks_status_sort_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_status_sort_idx ON public.tasks USING btree (status, sort_order);


--
-- Name: user_reminders_assigned_to_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_reminders_assigned_to_idx ON public.user_reminders USING btree (assigned_to);


--
-- Name: user_reminders_category_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_reminders_category_idx ON public.user_reminders USING btree (category_id);


--
-- Name: user_reminders_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_reminders_entity_idx ON public.user_reminders USING btree (entity_type, entity_id);


--
-- Name: user_reminders_remind_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_reminders_remind_at_idx ON public.user_reminders USING btree (remind_at);


--
-- Name: user_reminders_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_reminders_status_idx ON public.user_reminders USING btree (status);


--
-- Name: users_email_lower_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_email_lower_idx ON public.users USING btree (lower(email));


--
-- Name: users_username_lower_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_username_lower_idx ON public.users USING btree (lower(username));


--
-- Name: wa_campaigns_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wa_campaigns_status_idx ON public.wa_campaigns USING btree (status, created_at DESC);


--
-- Name: wa_recipients_claimable_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wa_recipients_claimable_idx ON public.wa_campaign_recipients USING btree (campaign_id, status, next_attempt_at);


--
-- Name: wa_recipients_idem_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX wa_recipients_idem_uidx ON public.wa_campaign_recipients USING btree (idempotency_key);


--
-- Name: wa_recipients_lease_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wa_recipients_lease_idx ON public.wa_campaign_recipients USING btree (status, lease_expires_at);


--
-- Name: wa_recipients_provider_msg_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wa_recipients_provider_msg_idx ON public.wa_campaign_recipients USING btree (provider_message_id);


--
-- Name: wa_send_log_bucket_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wa_send_log_bucket_idx ON public.wa_send_log USING btree (bucket, sent_at DESC);


--
-- Name: whatsapp_broadcasts_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX whatsapp_broadcasts_created_at_idx ON public.whatsapp_broadcasts USING btree (created_at DESC);


--
-- Name: whatsapp_instances_green_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX whatsapp_instances_green_id_idx ON public.whatsapp_instances USING btree (green_instance_id);


--
-- Name: whatsapp_templates_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX whatsapp_templates_active_idx ON public.whatsapp_templates USING btree (is_active);


--
-- Name: areas areas_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER areas_touch_updated_at BEFORE UPDATE ON public.areas FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: calendar_event_participants calendar_event_participants_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER calendar_event_participants_touch_updated_at BEFORE UPDATE ON public.calendar_event_participants FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: calendar_events calendar_events_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER calendar_events_touch_updated_at BEFORE UPDATE ON public.calendar_events FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: chips chips_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER chips_touch_updated_at BEFORE UPDATE ON public.chips FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: contact_people contact_people_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER contact_people_touch_updated_at BEFORE UPDATE ON public.contact_people FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: contacts contacts_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER contacts_touch_updated_at BEFORE UPDATE ON public.contacts FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: debtors debtors_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER debtors_touch_updated_at BEFORE UPDATE ON public.debtors FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: document_folders document_folders_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER document_folders_touch_updated_at BEFORE UPDATE ON public.document_folders FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: documents documents_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER documents_touch_updated_at BEFORE UPDATE ON public.documents FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: issue_comments issue_comments_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER issue_comments_touch_updated_at BEFORE UPDATE ON public.issue_comments FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: issues issues_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER issues_touch_updated_at BEFORE UPDATE ON public.issues FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: notifications notifications_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER notifications_touch_updated_at BEFORE UPDATE ON public.notifications FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: parking_spots parking_spots_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER parking_spots_touch_updated_at BEFORE UPDATE ON public.parking_spots FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: reminder_categories reminder_categories_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER reminder_categories_touch_updated_at BEFORE UPDATE ON public.reminder_categories FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: reminders reminders_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER reminders_touch_updated_at BEFORE UPDATE ON public.reminders FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: statuses statuses_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER statuses_touch_updated_at BEFORE UPDATE ON public.statuses FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: storage_units storage_units_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER storage_units_touch_updated_at BEFORE UPDATE ON public.storage_units FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: supplier_categories supplier_categories_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER supplier_categories_touch_updated_at BEFORE UPDATE ON public.supplier_categories FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: suppliers suppliers_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER suppliers_touch_updated_at BEFORE UPDATE ON public.suppliers FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: task_comments task_comments_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER task_comments_touch_updated_at BEFORE UPDATE ON public.task_comments FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: task_recurrences task_recurrences_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER task_recurrences_touch_updated_at BEFORE UPDATE ON public.task_recurrences FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: tasks tasks_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tasks_touch_updated_at BEFORE UPDATE ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: user_permissions user_permissions_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER user_permissions_touch_updated_at BEFORE UPDATE ON public.user_permissions FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: user_reminders user_reminders_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER user_reminders_touch_updated_at BEFORE UPDATE ON public.user_reminders FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: users users_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER users_touch_updated_at BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: wa_campaigns wa_campaigns_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER wa_campaigns_touch BEFORE UPDATE ON public.wa_campaigns FOR EACH ROW EXECUTE FUNCTION public.wa_touch_updated_at();


--
-- Name: wa_campaign_recipients wa_recipients_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER wa_recipients_touch BEFORE UPDATE ON public.wa_campaign_recipients FOR EACH ROW EXECUTE FUNCTION public.wa_touch_updated_at();


--
-- Name: whatsapp_instances whatsapp_instances_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER whatsapp_instances_touch_updated_at BEFORE UPDATE ON public.whatsapp_instances FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: whatsapp_templates whatsapp_templates_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER whatsapp_templates_touch_updated_at BEFORE UPDATE ON public.whatsapp_templates FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: app_settings app_settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_settings
    ADD CONSTRAINT app_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: audit_log audit_log_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: calendar_event_participants calendar_event_participants_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_event_participants
    ADD CONSTRAINT calendar_event_participants_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.calendar_events(id) ON DELETE CASCADE;


--
-- Name: calendar_events calendar_events_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_events
    ADD CONSTRAINT calendar_events_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: calendar_events calendar_events_parent_series_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_events
    ADD CONSTRAINT calendar_events_parent_series_id_fkey FOREIGN KEY (parent_series_id) REFERENCES public.calendar_events(id) ON DELETE CASCADE;


--
-- Name: chat_messages chat_messages_broadcast_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_broadcast_id_fkey FOREIGN KEY (broadcast_id) REFERENCES public.whatsapp_broadcasts(id) ON DELETE SET NULL;


--
-- Name: chat_messages chat_messages_debtor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_debtor_id_fkey FOREIGN KEY (debtor_id) REFERENCES public.debtors(id) ON DELETE SET NULL;


--
-- Name: chat_messages chat_messages_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES public.whatsapp_instances(id) ON DELETE SET NULL;


--
-- Name: chat_messages chat_messages_sent_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_sent_by_fkey FOREIGN KEY (sent_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: chat_messages chat_messages_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) ON DELETE SET NULL;


--
-- Name: chip_events chip_events_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chip_events
    ADD CONSTRAINT chip_events_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: chip_events chip_events_chip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chip_events
    ADD CONSTRAINT chip_events_chip_id_fkey FOREIGN KEY (chip_id) REFERENCES public.chips(id) ON DELETE CASCADE;


--
-- Name: chips chips_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chips
    ADD CONSTRAINT chips_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE RESTRICT;


--
-- Name: chips chips_deactivated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chips
    ADD CONSTRAINT chips_deactivated_by_fkey FOREIGN KEY (deactivated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: chips chips_issued_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chips
    ADD CONSTRAINT chips_issued_by_fkey FOREIGN KEY (issued_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: comments comments_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id);


--
-- Name: comments comments_debtor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_debtor_id_fkey FOREIGN KEY (debtor_id) REFERENCES public.debtors(id) ON DELETE CASCADE;


--
-- Name: completed_actions completed_actions_completed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.completed_actions
    ADD CONSTRAINT completed_actions_completed_by_fkey FOREIGN KEY (completed_by) REFERENCES public.users(id);


--
-- Name: completed_actions completed_actions_debtor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.completed_actions
    ADD CONSTRAINT completed_actions_debtor_id_fkey FOREIGN KEY (debtor_id) REFERENCES public.debtors(id) ON DELETE CASCADE;


--
-- Name: contact_people contact_people_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_people
    ADD CONSTRAINT contact_people_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: contacts contacts_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: debtor_events debtor_events_debtor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.debtor_events
    ADD CONSTRAINT debtor_events_debtor_id_fkey FOREIGN KEY (debtor_id) REFERENCES public.debtors(id) ON DELETE CASCADE;


--
-- Name: debtors debtors_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.debtors
    ADD CONSTRAINT debtors_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: debtors debtors_legal_status_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.debtors
    ADD CONSTRAINT debtors_legal_status_id_fkey FOREIGN KEY (legal_status_id) REFERENCES public.statuses(id);


--
-- Name: debtors debtors_legal_status_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.debtors
    ADD CONSTRAINT debtors_legal_status_updated_by_fkey FOREIGN KEY (legal_status_updated_by) REFERENCES public.users(id);


--
-- Name: document_folders document_folders_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_folders
    ADD CONSTRAINT document_folders_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: document_folders document_folders_parent_folder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_folders
    ADD CONSTRAINT document_folders_parent_folder_id_fkey FOREIGN KEY (parent_folder_id) REFERENCES public.document_folders(id) ON DELETE SET NULL;


--
-- Name: documents documents_folder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_folder_id_fkey FOREIGN KEY (folder_id) REFERENCES public.document_folders(id) ON DELETE SET NULL;


--
-- Name: documents documents_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id);


--
-- Name: entity_assignees entity_assignees_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_assignees
    ADD CONSTRAINT entity_assignees_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: entity_assignees entity_assignees_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_assignees
    ADD CONSTRAINT entity_assignees_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) ON DELETE CASCADE;


--
-- Name: entity_assignees entity_assignees_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_assignees
    ADD CONSTRAINT entity_assignees_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: import_runs import_runs_initiated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_runs
    ADD CONSTRAINT import_runs_initiated_by_fkey FOREIGN KEY (initiated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: internal_conversation_participants internal_conversation_participants_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internal_conversation_participants
    ADD CONSTRAINT internal_conversation_participants_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.internal_conversations(id) ON DELETE CASCADE;


--
-- Name: internal_conversation_participants internal_conversation_participants_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internal_conversation_participants
    ADD CONSTRAINT internal_conversation_participants_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: internal_conversations internal_conversations_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internal_conversations
    ADD CONSTRAINT internal_conversations_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: internal_messages internal_messages_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internal_messages
    ADD CONSTRAINT internal_messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.internal_conversations(id) ON DELETE CASCADE;


--
-- Name: internal_messages internal_messages_sender_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internal_messages
    ADD CONSTRAINT internal_messages_sender_user_id_fkey FOREIGN KEY (sender_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: issue_comments issue_comments_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issue_comments
    ADD CONSTRAINT issue_comments_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: issue_comments issue_comments_issue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issue_comments
    ADD CONSTRAINT issue_comments_issue_id_fkey FOREIGN KEY (issue_id) REFERENCES public.issues(id) ON DELETE CASCADE;


--
-- Name: issues issues_assigned_to_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issues
    ADD CONSTRAINT issues_assigned_to_user_id_fkey FOREIGN KEY (assigned_to_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: issues issues_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issues
    ADD CONSTRAINT issues_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: issues issues_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issues
    ADD CONSTRAINT issues_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) ON DELETE SET NULL;


--
-- Name: legal_status_history legal_status_history_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legal_status_history
    ADD CONSTRAINT legal_status_history_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES public.users(id);


--
-- Name: legal_status_history legal_status_history_debtor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legal_status_history
    ADD CONSTRAINT legal_status_history_debtor_id_fkey FOREIGN KEY (debtor_id) REFERENCES public.debtors(id) ON DELETE CASCADE;


--
-- Name: legal_status_history legal_status_history_new_status_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legal_status_history
    ADD CONSTRAINT legal_status_history_new_status_id_fkey FOREIGN KEY (new_status_id) REFERENCES public.statuses(id);


--
-- Name: legal_status_history legal_status_history_old_status_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legal_status_history
    ADD CONSTRAINT legal_status_history_old_status_id_fkey FOREIGN KEY (old_status_id) REFERENCES public.statuses(id);


--
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: parking_spots parking_spots_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parking_spots
    ADD CONSTRAINT parking_spots_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: parking_spots parking_spots_deactivated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parking_spots
    ADD CONSTRAINT parking_spots_deactivated_by_fkey FOREIGN KEY (deactivated_by) REFERENCES public.users(id);


--
-- Name: parking_spots parking_spots_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parking_spots
    ADD CONSTRAINT parking_spots_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: password_reset_tokens password_reset_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: reminder_categories reminder_categories_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reminder_categories
    ADD CONSTRAINT reminder_categories_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: reminders reminders_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reminders
    ADD CONSTRAINT reminders_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: sessions sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: statuses statuses_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statuses
    ADD CONSTRAINT statuses_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: statuses statuses_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statuses
    ADD CONSTRAINT statuses_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: storage_units storage_units_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_units
    ADD CONSTRAINT storage_units_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: storage_units storage_units_deactivated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_units
    ADD CONSTRAINT storage_units_deactivated_by_fkey FOREIGN KEY (deactivated_by) REFERENCES public.users(id);


--
-- Name: storage_units storage_units_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_units
    ADD CONSTRAINT storage_units_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: supplier_documents supplier_documents_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_documents
    ADD CONSTRAINT supplier_documents_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) ON DELETE CASCADE;


--
-- Name: suppliers suppliers_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suppliers
    ADD CONSTRAINT suppliers_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.supplier_categories(id) ON DELETE SET NULL;


--
-- Name: sync_runs sync_runs_triggered_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_runs
    ADD CONSTRAINT sync_runs_triggered_by_fkey FOREIGN KEY (triggered_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: task_comments task_comments_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_comments
    ADD CONSTRAINT task_comments_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: task_comments task_comments_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_comments
    ADD CONSTRAINT task_comments_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: task_occurrence_completions task_occurrence_completions_completed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_occurrence_completions
    ADD CONSTRAINT task_occurrence_completions_completed_by_fkey FOREIGN KEY (completed_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: task_occurrence_completions task_occurrence_completions_recurrence_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_occurrence_completions
    ADD CONSTRAINT task_occurrence_completions_recurrence_id_fkey FOREIGN KEY (recurrence_id) REFERENCES public.task_recurrences(id) ON DELETE SET NULL;


--
-- Name: task_occurrence_completions task_occurrence_completions_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_occurrence_completions
    ADD CONSTRAINT task_occurrence_completions_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: task_recurrence_exceptions task_recurrence_exceptions_recurrence_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_recurrence_exceptions
    ADD CONSTRAINT task_recurrence_exceptions_recurrence_id_fkey FOREIGN KEY (recurrence_id) REFERENCES public.task_recurrences(id) ON DELETE CASCADE;


--
-- Name: task_recurrences task_recurrences_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_recurrences
    ADD CONSTRAINT task_recurrences_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: tasks tasks_assigned_to_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_assigned_to_user_id_fkey FOREIGN KEY (assigned_to_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: tasks tasks_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: tasks tasks_debtor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_debtor_id_fkey FOREIGN KEY (debtor_id) REFERENCES public.debtors(id) ON DELETE SET NULL;


--
-- Name: tasks tasks_issue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_issue_id_fkey FOREIGN KEY (issue_id) REFERENCES public.issues(id) ON DELETE SET NULL;


--
-- Name: tasks tasks_parent_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_parent_task_id_fkey FOREIGN KEY (parent_task_id) REFERENCES public.tasks(id) ON DELETE SET NULL;


--
-- Name: tasks tasks_recurrence_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_recurrence_id_fkey FOREIGN KEY (recurrence_id) REFERENCES public.task_recurrences(id) ON DELETE SET NULL;


--
-- Name: tasks tasks_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) ON DELETE SET NULL;


--
-- Name: user_invites user_invites_invited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_invites
    ADD CONSTRAINT user_invites_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES public.users(id);


--
-- Name: user_permissions user_permissions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_permissions
    ADD CONSTRAINT user_permissions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_reminders user_reminders_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_reminders
    ADD CONSTRAINT user_reminders_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: user_reminders user_reminders_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_reminders
    ADD CONSTRAINT user_reminders_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.reminder_categories(id) ON DELETE SET NULL;


--
-- Name: user_reminders user_reminders_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_reminders
    ADD CONSTRAINT user_reminders_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: wa_campaign_recipients wa_campaign_recipients_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wa_campaign_recipients
    ADD CONSTRAINT wa_campaign_recipients_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.wa_campaigns(id) ON DELETE CASCADE;


--
-- Name: whatsapp_broadcasts whatsapp_broadcasts_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_broadcasts
    ADD CONSTRAINT whatsapp_broadcasts_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: whatsapp_broadcasts whatsapp_broadcasts_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_broadcasts
    ADD CONSTRAINT whatsapp_broadcasts_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES public.whatsapp_instances(id) ON DELETE SET NULL;


--
-- Name: whatsapp_instances whatsapp_instances_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_instances
    ADD CONSTRAINT whatsapp_instances_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: whatsapp_templates whatsapp_templates_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_templates
    ADD CONSTRAINT whatsapp_templates_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--


--
-- Dbmate schema migrations
--

INSERT INTO public.schema_migrations (version) VALUES
    ('20000101000001'),
    ('20000101000002'),
    ('20000101000003'),
    ('20000101000004'),
    ('20000101000005'),
    ('20000101000006'),
    ('20000101000007'),
    ('20000101000008'),
    ('20000101000009'),
    ('20000101000010'),
    ('20000101000011'),
    ('20000101000012'),
    ('20000101000013'),
    ('20000101000014'),
    ('20000101000015'),
    ('20000101000016'),
    ('20000101000017'),
    ('20000101000018'),
    ('20000101000019'),
    ('20000101000020'),
    ('20000101000021'),
    ('20000101000022'),
    ('20000101000023'),
    ('20000101000024'),
    ('20000101000025'),
    ('20000101000026'),
    ('20000101000027'),
    ('20000101000028'),
    ('20000101000029'),
    ('20000101000030'),
    ('20000101000031'),
    ('20000101000032'),
    ('20000101000033'),
    ('20000101000034'),
    ('20000101000035'),
    ('20000101000036'),
    ('20000101000037'),
    ('20000101000038'),
    ('20000101000039'),
    ('20000101000040'),
    ('20000101000041'),
    ('20000101000042'),
    ('20000101000043'),
    ('20000101000044'),
    ('20000101000045'),
    ('20000101000046'),
    ('20000101000047'),
    ('20000101000048'),
    ('20000101000049'),
    ('20000101000050'),
    ('20000101000051'),
    ('20000101000052'),
    ('20000101000053'),
    ('20000101000054'),
    ('20000101000055'),
    ('20000101000056'),
    ('20000101000057'),
    ('20000101000058'),
    ('20000101000059'),
    ('20000101000060'),
    ('20000101000061'),
    ('20000101000062'),
    ('20000101000063'),
    ('20000101000064'),
    ('20000101000065'),
    ('20000101000066'),
    ('20000101000067'),
    ('20000101000068'),
    ('20000101000069'),
    ('20000101000070'),
    ('20000101000071'),
    ('20000101000072'),
    ('20000101000073'),
    ('20000101000074'),
    ('20000101000075'),
    ('20000101000076'),
    ('20000101000077'),
    ('20000101000078'),
    ('20000101000079')
;
