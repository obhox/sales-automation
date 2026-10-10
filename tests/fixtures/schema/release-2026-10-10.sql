CREATE TABLE _migration_flags (key TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')));

CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      cookies_json TEXT,
      is_authenticated INTEGER DEFAULT 0,
      daily_connection_limit INTEGER DEFAULT 20,
      daily_message_limit INTEGER DEFAULT 50,
      daily_inmail_limit INTEGER DEFAULT 15,
      daily_visit_limit INTEGER DEFAULT 150,
      active_hours_start INTEGER DEFAULT 9,
      active_hours_end INTEGER DEFAULT 18,
      timezone TEXT DEFAULT 'UTC',
      working_days TEXT DEFAULT '1,2,3,4,5',
      created_at TEXT DEFAULT (datetime('now'))
    , inbox_synced_at TEXT, accepted_sync_at TEXT, connections_synced_through_ms INTEGER, li_connections INTEGER, li_pending INTEGER, li_profile_views INTEGER, li_stats_synced_at TEXT, withdraw_stale_invites INTEGER NOT NULL DEFAULT 0, workspace_id TEXT REFERENCES workspaces(id), proxy_url TEXT, proxy_username TEXT, proxy_password TEXT, sync_inbox INTEGER NOT NULL DEFAULT 1, inbox_synced_through_ms INTEGER, inbox_sync_requested_at TEXT, inbox_query_ids TEXT);

CREATE TABLE activity_logs (
      id TEXT PRIMARY KEY,
      target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
      type TEXT NOT NULL DEFAULT 'note' CHECK(type IN ('call', 'email', 'meeting', 'note', 'other')),
      body TEXT NOT NULL,
      logged_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    , workspace_id TEXT REFERENCES workspaces(id));

CREATE TABLE agent_config (
      id INTEGER PRIMARY KEY DEFAULT 1,
      system_prompt TEXT,
      user_prompt TEXT,
      email_examples TEXT,
      linkedin_examples TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    , default_model TEXT);

CREATE TABLE agent_sessions (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      target_id TEXT,
      step_id TEXT,
      model TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cost_usd REAL,
      prompt TEXT,
      generated_text TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    , workspace_id TEXT REFERENCES workspaces(id));

CREATE TABLE api_keys (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, key_prefix TEXT NOT NULL,
      scopes TEXT NOT NULL, created_by TEXT, last_used_at TEXT, expires_at TEXT,
      revoked_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id TEXT, action TEXT NOT NULL, entity_type TEXT, entity_id TEXT,
      metadata_json TEXT, ip_address TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE TABLE auth_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL CHECK(purpose IN ('password_reset','email_verify')),
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE TABLE companies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      domain TEXT,
      industry TEXT,
      location TEXT,
      linkedin_url TEXT,
      website TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    , founded_year INTEGER, logo_url TEXT, phone TEXT, annual_revenue TEXT, technology_names TEXT, keywords TEXT, city TEXT, country TEXT, description TEXT, employee_count INTEGER, email_domain_invalid INTEGER DEFAULT 0, workspace_id TEXT REFERENCES workspaces(id));

CREATE TABLE contact_custom_values (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
      field_id TEXT NOT NULL REFERENCES custom_field_definitions(id) ON DELETE CASCADE,
      value_text TEXT, value_number REAL, value_boolean INTEGER, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (target_id, field_id)
    );

CREATE TABLE custom_field_definitions (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL, key TEXT NOT NULL, field_type TEXT NOT NULL DEFAULT 'text',
      options_json TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(workspace_id, key)
    );

CREATE TABLE deliverability_checks (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      email_account_id TEXT REFERENCES email_accounts(id) ON DELETE CASCADE, domain TEXT NOT NULL,
      spf_status TEXT, dkim_status TEXT, dmarc_status TEXT, mx_status TEXT,
      score INTEGER NOT NULL DEFAULT 0, details_json TEXT, checked_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE TABLE domain_events (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      type TEXT NOT NULL, entity_type TEXT, entity_id TEXT, payload_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL DEFAULT (datetime('now')), processed_at TEXT
    );

CREATE TABLE email_accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      from_email TEXT NOT NULL,
      from_name TEXT,
      smtp_host TEXT NOT NULL,
      smtp_port INTEGER DEFAULT 587,
      smtp_secure INTEGER DEFAULT 0,
      imap_host TEXT,
      imap_port INTEGER DEFAULT 993,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      daily_email_limit INTEGER DEFAULT 50,
      active_hours_start INTEGER DEFAULT 9,
      active_hours_end INTEGER DEFAULT 18,
      timezone TEXT DEFAULT 'UTC',
      working_days TEXT DEFAULT '1,2,3,4,5',
      is_verified INTEGER DEFAULT 0,
      inbox_synced_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    , signature TEXT, reply_to TEXT, ramp_up_enabled INTEGER DEFAULT 1, ramp_start_date TEXT, imap_username TEXT, imap_password TEXT, workspace_id TEXT REFERENCES workspaces(id), provider TEXT NOT NULL DEFAULT 'smtp', oauth_connection_id TEXT REFERENCES mail_provider_connections(id), allow_self_signed INTEGER NOT NULL DEFAULT 0, paused_at TEXT, paused_reason TEXT, bounce_threshold REAL NOT NULL DEFAULT 0.03, complaint_threshold REAL NOT NULL DEFAULT 0.001, min_health_sample INTEGER NOT NULL DEFAULT 50, last_idle_at TEXT);

CREATE TABLE email_jobs (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      email_account_id TEXT NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
      idempotency_key TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'campaign',
      target_id TEXT REFERENCES targets(id) ON DELETE SET NULL, run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
      step_id TEXT REFERENCES workflow_steps(id) ON DELETE SET NULL,
      recipient TEXT NOT NULL, subject TEXT NOT NULL, body_text TEXT NOT NULL,
      email_delivery_mode TEXT NOT NULL DEFAULT 'plain' CHECK(email_delivery_mode IN ('plain','enhanced')),
      track_opens INTEGER NOT NULL DEFAULT 0, track_clicks INTEGER NOT NULL DEFAULT 0,
      reply_to_message_id TEXT, headers_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','leased','sending','sent','failed','uncertain','cancelled')),
      attempt INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
      available_at TEXT NOT NULL DEFAULT (datetime('now')), lease_owner TEXT, lease_expires_at TEXT,
      last_error TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), variant_id TEXT, unsubscribe_mode TEXT NOT NULL DEFAULT 'none', references_header TEXT,
      UNIQUE(workspace_id,idempotency_key)
    );

CREATE TABLE email_replies (
      id TEXT PRIMARY KEY,
      -- Nullable and SET NULL, not CASCADE: deleting a contact detaches their replies rather
      -- than destroying them. A detached reply stays visible in the inbox and can be re-linked.
      target_id TEXT REFERENCES targets(id) ON DELETE SET NULL,
      run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
      from_email TEXT NOT NULL,
      subject TEXT,
      body_text TEXT NOT NULL,
      received_at TEXT NOT NULL,
      classified_at TEXT,
      classification_json TEXT,
      classification_error TEXT,
      dispatched_at TEXT,
      dispatch_result_json TEXT,
      manually_edited INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    , workspace_id TEXT REFERENCES workspaces(id), assigned_to TEXT REFERENCES users(id), inbox_status TEXT NOT NULL DEFAULT 'open', sentiment TEXT, sla_due_at TEXT, locked_by TEXT REFERENCES users(id), locked_at TEXT, email_account_id TEXT REFERENCES email_accounts(id), message_id TEXT, imap_uid INTEGER, imap_uidvalidity INTEGER, in_reply_to_job_id TEXT, channel TEXT NOT NULL DEFAULT 'email', linkedin_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL, conversation_urn TEXT, external_id TEXT);

CREATE TABLE email_reply_tags (
      reply_id TEXT NOT NULL REFERENCES email_replies(id) ON DELETE CASCADE,
      tag_id TEXT NOT NULL REFERENCES inbox_tags(id) ON DELETE CASCADE, PRIMARY KEY(reply_id, tag_id)
    );

CREATE TABLE external_connections (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK(provider IN ('hubspot','salesforce','ical','google_calendar','microsoft_calendar')),
      name TEXT NOT NULL, config_json TEXT NOT NULL, secret_value TEXT,
      enabled INTEGER NOT NULL DEFAULT 1, last_synced_at TEXT, sync_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE TABLE external_sync_records (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      connection_id TEXT NOT NULL REFERENCES external_connections(id) ON DELETE CASCADE,
      entity_type TEXT NOT NULL, local_id TEXT NOT NULL, external_id TEXT,
      direction TEXT NOT NULL DEFAULT 'outbound', status TEXT NOT NULL DEFAULT 'pending',
      payload_json TEXT, error TEXT, synced_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(connection_id, entity_type, local_id)
    );

CREATE TABLE inbox_placement_tests (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      email_account_id TEXT REFERENCES email_accounts(id) ON DELETE CASCADE,
      seed_email TEXT NOT NULL, subject TEXT NOT NULL, message_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending', placement TEXT,
      sent_at TEXT, checked_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE TABLE inbox_tags (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#64748b', UNIQUE(workspace_id, name)
    );

CREATE TABLE "integrations" (
          key TEXT NOT NULL,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          api_key TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          PRIMARY KEY (workspace_id, key)
        );

CREATE TABLE linkedin_messages (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
      target_id TEXT REFERENCES targets(id) ON DELETE CASCADE,
      conversation_urn TEXT,
      message_urn TEXT,
      direction TEXT NOT NULL CHECK(direction IN ('in','out')),
      body TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'delivered',
      error TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE TABLE linkedin_withdrawals (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      target_id TEXT REFERENCES targets(id) ON DELETE SET NULL,
      source TEXT NOT NULL,
      outcome TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE TABLE list_imports (
      id TEXT PRIMARY KEY,
      list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'running',
      phase TEXT,
      page INTEGER DEFAULT 0,
      total_pages INTEGER DEFAULT 0,
      count INTEGER DEFAULT 0,
      total INTEGER DEFAULT 0,
      imported INTEGER DEFAULT 0,
      skipped INTEGER DEFAULT 0,
      error TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    , account_id TEXT, sales_nav_url TEXT, scheduled_for TEXT, start_page INTEGER DEFAULT 1, cap INTEGER, cancel_requested INTEGER DEFAULT 0, batch_index INTEGER DEFAULT 1, enrich INTEGER DEFAULT 0);

CREATE TABLE list_targets (
      list_id TEXT REFERENCES lists(id) ON DELETE CASCADE,
      target_id TEXT REFERENCES targets(id) ON DELETE CASCADE,
      PRIMARY KEY (list_id, target_id)
    );

CREATE TABLE lists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      sales_nav_url TEXT,
      purpose TEXT CHECK(purpose IN ('linkedin', 'email')),
      created_at TEXT DEFAULT (datetime('now'))
    , workspace_id TEXT REFERENCES workspaces(id));

CREATE TABLE logs (
      id TEXT PRIMARY KEY,
      run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
      target_id TEXT REFERENCES targets(id),
      level TEXT DEFAULT 'info' CHECK(level IN ('info', 'warn', 'error')),
      message TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

CREATE TABLE mail_oauth_states (
      state_hash TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, provider TEXT NOT NULL,
      redirect_after TEXT NOT NULL DEFAULT '/platform', expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE TABLE mail_provider_connections (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK(provider IN ('gmail','microsoft')),
      email TEXT NOT NULL, access_token TEXT NOT NULL, refresh_token TEXT,
      expires_at TEXT, scopes TEXT, provider_account_id TEXT,
      watch_id TEXT, watch_expires_at TEXT, client_state TEXT,
      enabled INTEGER NOT NULL DEFAULT 1, last_error TEXT, created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(workspace_id,provider,email)
    );

CREATE TABLE mcp_audit_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      request_json TEXT,
      success INTEGER NOT NULL DEFAULT 1,
      error TEXT,
      duration_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    , workspace_id TEXT REFERENCES workspaces(id));

CREATE TABLE meetings (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      connection_id TEXT REFERENCES external_connections(id) ON DELETE SET NULL,
      target_id TEXT REFERENCES targets(id) ON DELETE SET NULL, opportunity_id TEXT REFERENCES opportunities(id) ON DELETE SET NULL,
      external_id TEXT, title TEXT NOT NULL, starts_at TEXT NOT NULL, ends_at TEXT,
      attendees_json TEXT, status TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE TABLE oauth_auth_codes (
      code_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      scope TEXT,
      resource TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    , workspace_id TEXT REFERENCES workspaces(id));

CREATE TABLE oauth_clients (
      client_id TEXT PRIMARY KEY,
      client_name TEXT,
      redirect_uris TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

CREATE TABLE oauth_tokens (
      id TEXT PRIMARY KEY,
      access_hash TEXT NOT NULL UNIQUE,
      refresh_hash TEXT UNIQUE,
      client_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      scope TEXT,
      resource TEXT,
      expires_at TEXT NOT NULL,
      refresh_expires_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    , workspace_id TEXT REFERENCES workspaces(id));

CREATE TABLE opportunities (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      target_id TEXT REFERENCES targets(id) ON DELETE SET NULL, company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
      stage_id TEXT REFERENCES pipeline_stages(id) ON DELETE SET NULL, owner_id TEXT REFERENCES users(id),
      name TEXT NOT NULL, amount REAL, currency TEXT NOT NULL DEFAULT 'USD', expected_close_date TEXT,
      source TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    , closed_at TEXT);

CREATE TABLE pipeline_stages (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, probability INTEGER NOT NULL DEFAULT 0,
      is_won INTEGER NOT NULL DEFAULT 0, is_lost INTEGER NOT NULL DEFAULT 0
    );

CREATE TABLE provider_webhook_receipts (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      provider TEXT NOT NULL, replay_key TEXT NOT NULL, received_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(provider,replay_key)
    );

CREATE TABLE run_profile_tracks (
      id TEXT PRIMARY KEY,
      run_profile_id TEXT NOT NULL REFERENCES run_profiles(id) ON DELETE CASCADE,
      track TEXT NOT NULL CHECK(track IN ('linkedin', 'email')),
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'in_progress', 'completed', 'failed', 'skipped')),
      current_step INTEGER NOT NULL DEFAULT 0,
      last_step_at TEXT,
      next_step_at TEXT,
      error_message TEXT,
      last_email_subject TEXT,
      last_email_body TEXT,
      last_linkedin_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), pending_reply_context TEXT, attempts INTEGER NOT NULL DEFAULT 0,
      UNIQUE(run_profile_id, track)
    );

CREATE TABLE "run_profiles" (
        id TEXT PRIMARY KEY,
        run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
        target_id TEXT REFERENCES targets(id),
        email_account_id TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(run_id, target_id)
      );

CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT REFERENCES workflows(id),
      list_id TEXT REFERENCES lists(id),
      account_id TEXT REFERENCES accounts(id),
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'paused', 'completed', 'failed')),
      created_at TEXT DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      runner_pid INTEGER
    , email_account_id TEXT REFERENCES email_accounts(id), last_tick_at TEXT, workspace_id TEXT REFERENCES workspaces(id));

CREATE TABLE saved_replies (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL, body TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE TABLE search_filter_cache (
      id            TEXT NOT NULL,
      filter_type   TEXT NOT NULL,
      display_value TEXT NOT NULL,
      headline      TEXT,
      query         TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (filter_type, id)
    );

CREATE TABLE sender_events (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      email_account_id TEXT NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
      sent_message_id TEXT REFERENCES sent_messages(id) ON DELETE SET NULL,
      provider TEXT NOT NULL, provider_event_id TEXT, event_type TEXT NOT NULL,
      recipient TEXT, message_id TEXT, payload_json TEXT,
      occurred_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), is_bot INTEGER NOT NULL DEFAULT 0, bot_reason TEXT, user_agent TEXT,
      UNIQUE(provider,provider_event_id)
    );

CREATE TABLE sent_messages (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL UNIQUE REFERENCES email_jobs(id) ON DELETE CASCADE,
      email_account_id TEXT NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
      target_id TEXT REFERENCES targets(id) ON DELETE SET NULL, run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
      recipient TEXT NOT NULL, subject TEXT NOT NULL, message_id TEXT NOT NULL,
      provider_message_id TEXT, provider TEXT NOT NULL DEFAULT 'smtp', smtp_response TEXT,
      status TEXT NOT NULL DEFAULT 'accepted', accepted_at TEXT NOT NULL DEFAULT (datetime('now')),
      delivered_at TEXT, bounced_at TEXT, complained_at TEXT, deferred_at TEXT,
      last_provider_event_at TEXT, UNIQUE(workspace_id,message_id)
    );

CREATE TABLE signal_rules (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL, signal_type TEXT NOT NULL, min_score REAL NOT NULL DEFAULT 0,
      list_id TEXT REFERENCES lists(id) ON DELETE SET NULL, workflow_id TEXT REFERENCES workflows(id) ON DELETE SET NULL,
      account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL, enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    , auto_start INTEGER NOT NULL DEFAULT 0, email_account_id TEXT REFERENCES email_accounts(id) ON DELETE SET NULL);

CREATE TABLE signals (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      target_id TEXT REFERENCES targets(id) ON DELETE CASCADE, company_id TEXT REFERENCES companies(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('job_change','funding','hiring','technology','product_intent','custom')),
      title TEXT NOT NULL, description TEXT, score REAL NOT NULL DEFAULT 0, source TEXT,
      occurred_at TEXT NOT NULL, metadata_json TEXT, processed_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE TABLE step_sends (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      run_id TEXT,
      workflow_id TEXT,
      step_id TEXT,
      target_id TEXT REFERENCES targets(id) ON DELETE SET NULL,
      channel TEXT NOT NULL,
      action TEXT NOT NULL,
      account_id TEXT,
      email_account_id TEXT,
      template_id TEXT,
      variant_id TEXT,
      email_job_id TEXT,
      sent_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE TABLE suppressions (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('email','domain','linkedin','phone')),
      value TEXT NOT NULL, reason TEXT NOT NULL DEFAULT 'manual', source TEXT,
      target_id TEXT REFERENCES targets(id) ON DELETE SET NULL, created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(workspace_id, kind, value)
    );

CREATE TABLE "targets" (id TEXT PRIMARY KEY,
linkedin_url TEXT,
sales_nav_url TEXT,
first_name TEXT,
last_name TEXT,
full_name TEXT,
title TEXT,
company TEXT,
location TEXT,
profile_image_url TEXT,
degree INTEGER,
connection_requested_at TEXT,
connected_at TEXT,
message_sent_at TEXT,
last_replied_at TEXT,
linkedin_member_urn TEXT,
enriched_at TEXT,
created_at TEXT DEFAULT (datetime('now')),
headline TEXT,
summary TEXT,
messaging_urn TEXT,
object_urn TEXT,
open_link INTEGER DEFAULT 0,
company_industry TEXT,
company_location TEXT,
tenure_months INTEGER,
spotlight_badges TEXT,
positions_json TEXT,
skills_json TEXT,
enriched_profile_at TEXT,
email TEXT,
email_replied_at TEXT,
company_id TEXT,
apollo_id TEXT,
seniority TEXT,
apollo_functions TEXT,
company_description TEXT,
company_size INTEGER,
apollo_enriched_at TEXT,
email_status TEXT,
notes TEXT,
city TEXT,
country TEXT,
time_zone TEXT,
apollo_departments TEXT,
email_domain_catchall INTEGER DEFAULT 0,
reply_kind TEXT,
inmail_sent_at TEXT,
posts_json TEXT,
posts_scraped_at TEXT,
invite_withdrawn_at TEXT,
phone TEXT,
workspace_id TEXT,
owner_id TEXT,
intent_score REAL NOT NULL DEFAULT 0,
email_verified_at TEXT,
email_verify_requested_at TEXT,
unsubscribed_at TEXT,
linkedin_profile_id TEXT);

CREATE TABLE templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    , workspace_id TEXT REFERENCES workspaces(id));

CREATE TABLE todos (
      id TEXT PRIMARY KEY,
      target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      due_date TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'done')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    , description TEXT, workspace_id TEXT REFERENCES workspaces(id));

CREATE TABLE user_settings (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, key)
    );

CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    , email_verified_at TEXT, sessions_valid_after INTEGER);

CREATE TABLE warmup_messages (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      from_account_id TEXT NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
      to_account_id TEXT NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
      subject TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'scheduled',
      scheduled_at TEXT NOT NULL, sent_at TEXT, error TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    , message_id TEXT, replied_at TEXT, engaged_at TEXT, rescued_at TEXT);

CREATE TABLE warmup_settings (
      email_account_id TEXT PRIMARY KEY REFERENCES email_accounts(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 0, daily_target INTEGER NOT NULL DEFAULT 5,
      reply_rate INTEGER NOT NULL DEFAULT 60, started_at TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE TABLE webhook_deliveries (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      event_id TEXT NOT NULL REFERENCES domain_events(id) ON DELETE CASCADE,
      endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
      attempt INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
      next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')), response_status INTEGER,
      response_body TEXT, last_error TEXT, delivered_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(event_id, endpoint_id)
    );

CREATE TABLE webhook_endpoints (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      url TEXT NOT NULL, secret TEXT NOT NULL, event_types TEXT NOT NULL DEFAULT '*',
      enabled INTEGER NOT NULL DEFAULT 1, created_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE TABLE worker_leases (
      name TEXT PRIMARY KEY, owner_id TEXT NOT NULL, expires_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE TABLE workflow_branches (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      source_step_id TEXT NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
      conditions_json TEXT NOT NULL, true_step_id TEXT REFERENCES workflow_steps(id) ON DELETE SET NULL,
      false_step_id TEXT REFERENCES workflow_steps(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(source_step_id)
    );

CREATE TABLE workflow_step_email_variants (
      id TEXT PRIMARY KEY,
      step_id TEXT NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    , disabled_at TEXT);

CREATE TABLE workflow_step_templates (
      step_id TEXT REFERENCES workflow_steps(id) ON DELETE CASCADE,
      template_id TEXT REFERENCES templates(id) ON DELETE CASCADE,
      PRIMARY KEY (step_id, template_id)
    );

CREATE TABLE "workflow_steps" (
          id TEXT PRIMARY KEY,
          workflow_id TEXT REFERENCES workflows(id) ON DELETE CASCADE,
          step_order INTEGER NOT NULL,
          step_type TEXT NOT NULL CHECK(step_type IN ('visit', 'connect', 'message', 'sales_inmail', 'delay', 'email')),
          template_id TEXT REFERENCES templates(id),
          delay_seconds INTEGER DEFAULT 0,
          connect_note TEXT,
          message_body TEXT,
          email_subject TEXT,
          email_body TEXT,
          enabled INTEGER DEFAULT 1,
          ai_enabled INTEGER DEFAULT 0,
          ai_model TEXT,
          ai_prompt TEXT,
          ai_max_words INTEGER,
          email_position INTEGER DEFAULT 1,
          message_position INTEGER DEFAULT 1,
          ai_language TEXT DEFAULT 'English',
          track TEXT NOT NULL DEFAULT 'linkedin' CHECK(track IN ('linkedin', 'email')),
          email_signature TEXT,
          email_delivery_mode TEXT NOT NULL DEFAULT 'plain' CHECK(email_delivery_mode IN ('plain','enhanced')),
          email_track_opens INTEGER NOT NULL DEFAULT 0,
          email_track_clicks INTEGER NOT NULL DEFAULT 0,
          email_in_thread INTEGER NOT NULL DEFAULT 0,
          email_control_disabled INTEGER NOT NULL DEFAULT 0
        );

CREATE TABLE workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    , prompt TEXT, is_archived INTEGER NOT NULL DEFAULT 0, workspace_id TEXT REFERENCES workspaces(id), send_in_recipient_tz INTEGER NOT NULL DEFAULT 0);

CREATE TABLE workspace_ai_config (
      workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
      default_model TEXT, system_prompt TEXT, user_prompt TEXT, email_examples TEXT, linkedin_examples TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE TABLE workspace_invitations (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','admin','manager','member','viewer')),
      token_hash TEXT NOT NULL UNIQUE,
      invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      expires_at TEXT NOT NULL,
      accepted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      accepted_at TEXT,
      revoked_at TEXT,
      last_sent_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE TABLE workspace_members (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','admin','manager','member','viewer')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (workspace_id, user_id)
    );

CREATE TABLE workspace_settings (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (workspace_id, key)
    );

CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      created_by TEXT REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE INDEX idx_activity_logs_target_id ON activity_logs(target_id);

CREATE INDEX idx_auth_tokens_user ON auth_tokens(user_id, purpose);

CREATE INDEX idx_email_jobs_ready ON email_jobs(status,available_at,lease_expires_at);

CREATE INDEX idx_email_jobs_thread ON email_jobs(run_id, target_id, status, created_at);

CREATE INDEX idx_email_replies_dispatched_at ON email_replies(dispatched_at);

CREATE UNIQUE INDEX idx_email_replies_external ON email_replies(workspace_id, external_id) WHERE external_id IS NOT NULL;

CREATE INDEX idx_email_replies_from_email ON email_replies(workspace_id, from_email);

CREATE INDEX idx_email_replies_imap_uid ON email_replies(email_account_id, imap_uid);

CREATE INDEX idx_email_replies_message_id ON email_replies(email_account_id, message_id);

CREATE INDEX idx_email_replies_target_id ON email_replies(target_id);

CREATE INDEX idx_events_pending ON domain_events(processed_at, occurred_at);

CREATE INDEX idx_linkedin_messages_target ON linkedin_messages(target_id, sent_at);

CREATE UNIQUE INDEX idx_linkedin_messages_urn ON linkedin_messages(workspace_id, message_urn) WHERE message_urn IS NOT NULL;

CREATE INDEX idx_linkedin_withdrawals_account ON linkedin_withdrawals(account_id, created_at);

CREATE INDEX idx_linkedin_withdrawals_target ON linkedin_withdrawals(target_id);

CREATE INDEX idx_list_imports_scheduled ON list_imports(status, scheduled_for);

CREATE INDEX idx_mcp_audit_client ON mcp_audit_logs(client_id);

CREATE INDEX idx_mcp_audit_created ON mcp_audit_logs(created_at);

CREATE INDEX idx_opportunities_workspace_stage ON opportunities(workspace_id, stage_id);

CREATE INDEX idx_replies_team ON email_replies(workspace_id, inbox_status, assigned_to, sla_due_at);

CREATE INDEX idx_run_profile_tracks_run_profile_id ON run_profile_tracks(run_profile_id);

CREATE INDEX idx_run_profile_tracks_state_next ON run_profile_tracks(state, next_step_at);

CREATE UNIQUE INDEX idx_run_profiles_unique ON run_profiles(run_id, target_id);

CREATE INDEX idx_sender_events_engagement ON sender_events(sent_message_id, event_type, is_bot);

CREATE INDEX idx_sender_events_health ON sender_events(email_account_id,event_type,occurred_at);

CREATE INDEX idx_sender_events_type ON sender_events(workspace_id, event_type, occurred_at);

CREATE INDEX idx_sent_messages_message_id ON sent_messages(workspace_id,message_id);

CREATE INDEX idx_sent_messages_provider ON sent_messages(provider,provider_message_id);

CREATE INDEX idx_sfc_type_display ON search_filter_cache(filter_type, display_value);

CREATE INDEX idx_sfc_type_query ON search_filter_cache(filter_type, query);

CREATE INDEX idx_signals_target ON signals(workspace_id, target_id, occurred_at);

CREATE UNIQUE INDEX idx_step_sends_email_job ON step_sends(email_job_id) WHERE email_job_id IS NOT NULL;

CREATE INDEX idx_step_sends_target ON step_sends(target_id, sent_at);

CREATE INDEX idx_step_sends_wf ON step_sends(workflow_id, step_id, sent_at);

CREATE INDEX idx_step_sends_wf_target ON step_sends(workflow_id, target_id, sent_at);

CREATE INDEX idx_suppressions_lookup ON suppressions(workspace_id, kind, value);

CREATE INDEX idx_targets_messaging_urn ON targets(messaging_urn);

CREATE INDEX idx_targets_workspace_email ON targets(workspace_id, email);

CREATE UNIQUE INDEX idx_targets_workspace_linkedin ON targets(workspace_id, linkedin_url) WHERE linkedin_url IS NOT NULL;

CREATE INDEX idx_todos_status ON todos(status);

CREATE INDEX idx_todos_target_id ON todos(target_id);

CREATE INDEX idx_webhook_deliveries_pending ON webhook_deliveries(status, next_attempt_at);

CREATE INDEX idx_workflow_step_email_variants_step ON workflow_step_email_variants(step_id);

CREATE INDEX idx_workspace_invites_pending ON workspace_invitations(workspace_id, email, accepted_at, revoked_at, expires_at);

INSERT INTO _migration_flags (key) VALUES ('backfill_opportunity_closed_at_v1');

INSERT INTO _migration_flags (key) VALUES ('backfill_step_sends_v1');

INSERT INTO _migration_flags (key) VALUES ('classify_historical_open_bots_v1');

INSERT INTO _migration_flags (key) VALUES ('clear_bad_verification_suppressions_v1');

INSERT INTO _migration_flags (key) VALUES ('demote_unprobed_verified_v1');

INSERT INTO _migration_flags (key) VALUES ('existing_users_verified_v1');

INSERT INTO _migration_flags (key) VALUES ('legacy_workspace_seeded_v1');

INSERT INTO _migration_flags (key) VALUES ('repair_company_workspaces_v1');

INSERT INTO _migration_flags (key) VALUES ('scope_app_settings_v1');

INSERT INTO _migration_flags (key) VALUES ('suppress_existing_catchall_v1');
