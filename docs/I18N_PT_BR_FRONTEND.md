# Linki — i18n frontend (pt-BR / en)

This is a **frontend localization contribution** for Linki. It includes Brazilian
Portuguese (pt-BR) and preserves English (en) as a selectable UI language.

## Scope and compatibility

The changes focus on visible UI content, forms, navigation, user-facing error
messages and guided tours. API routes, payload identifiers, background
automation, OAuth callbacks and delivery rules retain their original contracts.

- Source English text is preserved where needed by internal models and
  integrations, while presentation components render translations.
- Unrecognized third-party/provider-generated messages may still appear in
  English, rather than silently changing their meaning.
- Authentication and app navigation do not gain locale-prefixed URLs.

## Implementation

- **Next.js Pages Router**: `pages/_app.tsx` wraps existing providers in
  `LocaleProvider`. No locale-prefixed routes or proxy changes.
- **next-intl** for text catalogs in `messages/en.json` and
  `messages/pt-BR.json`. Catalog keys must be kept equal.
- **Locale default**: pt-BR, selectable English.
- **Preference**: cookie `LINKI_UI_LOCALE`, one year, SameSite=Lax,
  Secure on HTTPS. Language controls in public auth frame and account menu.
- **Hydration**: `useSyncExternalStore` initially renders pt-BR on both
  server and client, reading browser preference after hydration.
- **User-facing errors**: known API/auth messages translated by
  `localizeAuthError` and `localizeRequestError` while API contracts remain
  unchanged. Unrecognized provider errors preserve their original text.
- **No global locale routing**: auth redirects, API, webhook and OAuth
  callback URLs remain untouched.

## Translated frontend areas

- Sign-in, sign-up, password reset, 404 and 500 pages.
- Auth explanation panel, navigation sidebar, account menu.
- Campaign listing: main actions, table headings, filters, statuses, empty
  states, archive and delete confirmations.
- Contacts listing: search, filtering, actions, main empty states and prompts.
- Contacts dialogs: create contact, add to list/campaign, tag management, Apollo
  enrichment and personalized research; pricing warnings, progress messages
  and action feedback localized in both languages.
- Individual contact profile: main actions, owner changes, reply confirmations,
  LinkedIn refresh, destructive-action warnings and principal notifications.
- Profile side cards: contact details, notes, company, career, campaigns, lists,
  custom fields and task controls, including clipboard feedback.
- Profile dialogs: edit contact, log activity, tasks, LinkedIn messaging, manual
  email, and meeting booking settings; API identifiers and behavior unchanged.
- Contact timeline: channel filters, states, user actions and event titles for
  messages, opens/clicks, replies, LinkedIn, list updates and logged activities.
- Inbox: main actions, saved views, counters, reply-check notifications.
- Inbox composer: reply channels, sender selection, draft autosave, attachments,
  merge tags, booking links, AI rewriting, link insertion and send/snooze/close
  safeguards. pt-BR relative timestamps localized; API operations preserved.
- Inbox dialogs: tag management, saved replies, saved views, conversation relinking,
  booking URL and destructive-operation confirmations; tag color accessibility
  labels localized without changing the stored hexadecimal color codes.
- Inbox conversation list and filters: sort choices, search, pagination, empty
  states, reply status, verdict, sentiment, owners, SLA and tag/view filters.
- Inbox thread: header and triage controls, classification, scheduling and snooze,
  assigned member, message history, attachments, re-send/discard warnings and
  unsubscribe/cancel-follow-up confirmations. Locale-specific inbox dates added.
  Recognized classifier verdicts, suggested actions and automated dispatch
  explanations are localized; arbitrary provider/AI-generated summaries and
  unknown errors may still be in English.
- Templates library and template editing form: primary labels and actions.
- Account/profile/password: fields, validation, visible guidance.
- Team screen: main headings and controls.
- Team administration: member roles and status, role-change/suspension/removal
  warnings, invitations and delivery notices, workspace list and role/capability
  comparison. Operational role IDs, authorization rules and API payloads unchanged.
- Audit log: main filters and controls, known workspace/member/invitation actions,
  localized dates and pagination. Unrecognized action names and server-originated
  audit metadata retain their source wording.
- App shell: responsive navigation labels, command palette search (supports original
  English and translated navigation names), help and guided tours, unread
  notifications and workspace switching. Dynamic notification content from the
  backend remains source-dependent.
- AI and models: OpenRouter credentials, model selection, default/fallback
  behavior, writing style, tone and examples, per-step overrides, test previews
  and USD spending/budget. The message-writing API, model IDs, OpenRouter
  billing and saved language values remain unchanged. Provider-generated text,
  raw diagnostics and some server-supplied notices can still be in English.
- Signals: feed filters, sources, time stamps and actions, manual recording,
  rule creation/automation, watched accounts and Apollo detection/credit caps,
  confirmation prompts and run history. Signal type values, rule/action IDs
  and cost calculations are preserved. Unrecognized or server-generated
  descriptions can still be in English.
- CSV import: upload and file validation, preview and replacement, column
  mapping and custom fields, duplicate strategy, target list, review, import
  results and unfinished draft recovery. Some backend/model-produced
  validation issue descriptions may remain in English.
- Developer API: keys, 14 scopes, expiration and rate limits, endpoint
  webhooks and HMAC secrets, delivery logs/dead-letter queue, MCP and health
  cards, API reference and descriptions of 34 endpoints. API methods, paths,
  scope identifiers, event names, signing examples and payloads unchanged.
- Mailbox overview: KPIs, actions, empty state and key confirmations.
- Mailbox configuration: connect by Gmail app password or external SMTP/IMAP,
  edit sending windows, daily limits, ramps, guard, warm-up, reply-to, security
  and credentials; domain DNS status, mailbox status and queue, test sends,
  signatures and workspace warm-up/rotation dialogs. Technical identifiers,
  connection tests and API values remain unchanged. Dynamic provider errors,
  some model-generated diagnostics and third-party labels may remain in English.
- Integrations overview: connection status, commands and main notifications.
- Dashboard: main KPI labels, filters, chart and funnel stage labels, alerts,
  overview cards and onboarding actions. Dynamic model-generated explanations
  may still be in English.
- Campaign creation wizard: step navigation, save/launch feedback, list
  selection, AI brief, sender selection and final prelaunch review.
  Backend-generated readiness descriptions may still be in English.
- Campaign detail: analytics overview, KPI and conversion cards, A/B tests,
  add-prospect and report-sharing dialogs, prospect list and run log, plus
  campaign configuration (sender assignment, scheduling, exclusions, spam,
  tracking, archive and delete). Backend-generated results, arbitrary log
  messages and some model descriptions can still appear in English.
- Contact management: contact table columns/statuses/actions, contact tags,
  custom fields and saved views, including permissions, saved-view sharing
  and destructive-operation confirmations.
- Sequence editor: publish/discard actions, conflict warnings, channel controls,
  step configuration, wait windows, A/B variants, template rotation, AI writing,
  conditions and outcome actions, preview dialogs, test-email safety notices.
- Spam warnings: modes, severities, rule explanations and cleanup controls.
  The underlying spam engine and its scoring behavior remain unchanged.
- Lists index: search, filters, bulk actions, main table labels, empty states,
  verification notifications, archive and deletion confirmations.
- LinkedIn accounts overview: main KPIs, connect/pause/reconnect actions,
  synchronization feedback, cleanup and disconnection confirmations.
- List dialogs: create/edit, Sales Navigator import, import jobs, daily caps,
  connection synchronization and moving contacts across lists.
- LinkedIn account forms: connection by login or session cookie, proxy setup,
  verification codes, mobile approval, safety explanations, read-only tests,
  deletion confirmation, preset limits, warm-up and schedule controls.
- Shared LinkedIn settings: Portuguese weekday names, time-zone hints and
  numeric field validation feedback, without changing validation rules.
- List detail screen: actions, filtering, verification, confirmation dialogs,
  selected contacts, empty states and campaign history headings.
- LinkedIn account cards: connection states, action menu, account owner/proxy
  labels, weekday indicators, invitation cleanup hints and meter headings.
- Companies/CRM: company list, search, filtering, sorting, target flags,
  deletion confirmations and row summaries; company detail headings,
  enrichment, contacts, suggested people, signals and action menus.
- Company dialogs (current coverage): add/edit company, target account flag,
  domain fields, CSV import and import validation/results. Other Apollo
  workflow dialogs and provider-generated messages still need translation.
- Pipeline: view selector, owner filters, opportunity/board controls, task
  list and editor (filters, priorities, deadlines, confirmations), activity
  filters and manual log, meeting list, contact matching and calendar/ICS
  connection forms. Stage administration and model-generated descriptive
  text still need translation.
- Deliverability: overview, period and domain selector, DNS checks and DKIM
  selector, mailbox health, warm-up controls, guard log, do-not-contact
  administration and inbox placement tests, including confirmation warnings.
  Provider-generated diagnostic detail, scoring advice and certain dynamic
  model strings still need translation.

## Known limitations

The interface is extensively localized, but dynamic text from external services,
provider error bodies, raw API logs and arbitrary AI-generated summaries may still
be shown in their source language. The locale of generated outreach copy is a
separate campaign setting and is **not** changed by the UI language switch.

Some dynamically generated model strings and backend validation detail may still
need additional mapping as they are discovered. This contribution deliberately
does not translate persisted API values, provider identifiers, OAuth paths,
webhook payloads, or customer-authored content.

## Validation

The implementation retains English alongside Portuguese and validates catalogs
in both locales. To verify locally:

```bash
npm ci
npx tsc --noEmit
npx eslint components/ pages/ lib/client/api.ts tests/i18n-*.test.ts
npx vitest run tests/i18n-*.test.ts tests/tours.test.ts
npm run build
```

The i18n-focused test suite checks dictionary key parity, ICU message syntax,
auth and API error mappings, representative user flows and 19 guided tours
(52 steps). A manual browser smoke test is also recommended for language
switching, persistence, dynamic data, layout and accessibility.

The wider application test suite contains integration tests for external
services and databases; evaluate unrelated flaky failures separately rather
than claiming an all-green full suite.

## Guided tours

- `components/shell/TourHost.tsx` uses `GuidedTours` from `messages/en.json` and `messages/pt-BR.json`. The 19 tours and all 52 indexed steps are localized; driver.js progression and buttons are localized as well.
- `lib/client/tours.ts` retains the canonical English texts and selectors as data, preserving the existing tour model and tests. Step translations are applied before filtering hidden targets to prevent shifting the translations of later steps.
- `tests/i18n-guided-tours.test.ts` verifies key parity, ICU validity, welcome texts, controls, progress and step indexing. Original `tests/tours.test.ts` remains unchanged.
- Tours already marked as read can be replayed from the Help menu, in either language.
