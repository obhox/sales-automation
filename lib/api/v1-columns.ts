// The fields the public API (/api/v1) returns, table by table.
//
// The API used to return whole rows (SELECT *), which meant every column ever
// added to one of these tables was published the moment it was created, whether
// or not anyone meant it to be. The lists below are exactly what was being
// returned when they were written (10 October 2026), so nothing changed for
// existing callers.
//
// When you add a column to one of these tables, decide which it is:
//   - part of the public API  → add it to V1_COLUMNS
//   - internal                → add it to V1_WITHHELD
// tests/api-v1-columns.test.ts fails until every column is in one or the other.

export const V1_COLUMNS = {
  targets: [
    "id", "linkedin_url", "sales_nav_url", "first_name", "last_name", "full_name", "title", "company", "location", "profile_image_url", "degree",
    "connection_requested_at", "connected_at", "message_sent_at", "last_replied_at", "linkedin_member_urn", "enriched_at", "created_at", "headline",
    "summary", "messaging_urn", "object_urn", "open_link", "company_industry", "company_location", "tenure_months", "spotlight_badges",
    "positions_json", "skills_json", "enriched_profile_at", "email", "email_replied_at", "company_id", "apollo_id", "seniority", "apollo_functions",
    "company_description", "company_size", "apollo_enriched_at", "email_status", "notes", "city", "country", "time_zone", "apollo_departments",
    "email_domain_catchall", "reply_kind", "inmail_sent_at", "posts_json", "posts_scraped_at", "invite_withdrawn_at", "phone", "workspace_id",
    "owner_id", "intent_score", "email_verified_at", "email_verify_requested_at", "unsubscribed_at", "linkedin_profile_id",
  ],
  companies: [
    "id", "name", "domain", "industry", "location", "linkedin_url", "website", "notes", "created_at", "founded_year", "logo_url", "phone",
    "annual_revenue", "technology_names", "keywords", "city", "country", "description", "employee_count", "email_domain_invalid", "workspace_id",
  ],
  lists: [
    "id", "name", "description", "sales_nav_url", "purpose", "created_at", "workspace_id",
  ],
  workflows: [
    "id", "name", "description", "created_at", "prompt", "is_archived", "workspace_id", "send_in_recipient_tz",
  ],
  runs: [
    "id", "workflow_id", "list_id", "account_id", "status", "created_at", "started_at", "completed_at", "runner_pid", "email_account_id",
    "last_tick_at", "workspace_id",
  ],
  domain_events: [
    "id", "workspace_id", "type", "entity_type", "entity_id", "payload_json", "occurred_at", "processed_at",
  ],
  signals: [
    "id", "workspace_id", "target_id", "company_id", "type", "title", "description", "score", "source", "occurred_at", "metadata_json",
    "processed_at", "created_at",
  ],
  opportunities: [
    "id", "workspace_id", "target_id", "company_id", "stage_id", "owner_id", "name", "amount", "currency", "expected_close_date", "source",
    "created_at", "updated_at", "closed_at",
  ],
  signal_rules: [
    "id", "workspace_id", "name", "signal_type", "min_score", "list_id", "workflow_id", "account_id", "enabled", "created_at", "auto_start",
    "email_account_id",
  ],
  pipeline_stages: [
    "id", "workspace_id", "name", "position", "probability", "is_won", "is_lost",
  ],
  suppressions: [
    "id", "workspace_id", "kind", "value", "reason", "source", "target_id", "created_by", "created_at",
  ],
  sent_messages: [
    "id", "workspace_id", "job_id", "email_account_id", "target_id", "run_id", "recipient", "subject", "message_id", "provider_message_id",
    "provider", "smtp_response", "status", "accepted_at", "delivered_at", "bounced_at", "complained_at", "deferred_at", "last_provider_event_at",
  ],
  run_profiles: [
    "id", "run_id", "target_id", "email_account_id", "created_at",
  ],
  run_profile_tracks: [
    "id", "run_profile_id", "track", "state", "current_step", "last_step_at", "next_step_at", "error_message", "last_email_subject",
    "last_email_body", "last_linkedin_message", "created_at", "pending_reply_context", "attempts",
  ],
} as const satisfies Record<string, readonly string[]>;

export type V1Table = keyof typeof V1_COLUMNS;

/** Columns that exist on these tables and are deliberately not returned. */
export const V1_WITHHELD: Partial<Record<V1Table, readonly string[]>> = {};

/** `a, b, c` for a SELECT, optionally qualified with a table alias. */
export function v1Select(table: V1Table, alias?: string): string {
  return V1_COLUMNS[table].map(column => (alias ? `${alias}.${column}` : column)).join(", ");
}
