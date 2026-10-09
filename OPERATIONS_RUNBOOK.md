# Linki Operations Runbook

Practical procedures for running Linki on the single 8 GB VPS. All commands assume the deploy directory `/opt/linki` and the compose service name `linki`.

Quick health commands used throughout:
```bash
docker compose ps
docker inspect --format '{{.State.Health.Status}}' $(docker compose ps -q linki)
curl -fsS "http://127.0.0.1:${PORT:-3456}/api/health?ready=1"
docker compose logs --tail=200 linki
docker stats --no-stream
df -h / ; free -h ; du -sh /opt/linki/data
```

## Application crash

Symptom: container exited or restarting; `/api/health` unreachable.
1. `docker compose ps` and `docker compose logs --tail=200 linki` to see the exit reason.
2. If the log shows an environment error (for example a missing `NEXTAUTH_SECRET`), fix `.env.local` and `docker compose up -d`. The app fails fast by design on missing required variables.
3. Otherwise `docker compose up -d` (restart policy `unless-stopped` will also auto-restart). Confirm `healthy` and readiness `db:up`.

## Worker crash

Note: workers run inside the same process as the app; there is no separate worker container. A "worker crash" is an app crash. Follow the application-crash steps. On restart, leased jobs recover automatically:
- Expired-lease jobs return to `pending`.
- Jobs caught mid-provider-handoff become `uncertain` (see stuck jobs below).

## Chromium crash

Symptom: LinkedIn actions failing; logs show Playwright/Chromium errors; possible orphaned processes.
1. Check memory first: `docker stats --no-stream`. A Chromium crash is often an OOM symptom.
2. `docker compose restart linki`. The session layer reaps dead browsers and relaunches on next tick.
3. Do not change Chromium flags, the pinned version, or the fingerprint. If Chromium repeatedly SIGTRAPs, verify the image is the pinned build and has not been rebuilt against a newer Chromium.
4. If a LinkedIn session was invalidated, see "Expired LinkedIn session".

## Out-of-memory event

Symptom: OOM kill in `dmesg` or the container restarting under load; Chromium dying.
1. `free -h` and `docker stats` to confirm.
2. Restart to clear: `docker compose restart linki`.
3. If recurring, ensure no `mem_limit` is set too tightly (see DEPLOYMENT.md). Chromium plus the app can transiently need 2 to 2.5 GB.
4. As an emergency backstop only, enable host swap. This is not a fix; reduce concurrent load and keep at least ~1 GB free.

## Full disk

Symptom: writes failing; `df -h /` near 100 percent.
1. Identify the consumer: `du -sh /opt/linki/data`, `docker system df`.
2. Reclaim Docker space safely: `docker image prune -f` and `docker builder prune -f`. Never `docker volume prune` or `docker compose down -v`.
3. Container logs are capped at 50 MB by config; if they were not, they are the likely culprit before the cap took effect.
4. If the SQLite database is large, prune high-growth tables (see "Database growth").

## Database unavailable

Symptom: readiness returns `db:"down"` (503); app errors referencing SQLite.
1. `curl "http://127.0.0.1:${PORT}/api/health?ready=1"` to confirm.
2. Check disk (a full disk makes WAL writes fail) and file permissions on `/opt/linki/data` (the container runs as the non-root `node` user).
3. `docker compose restart linki`.
4. If the database file is corrupt, restore from the latest backup (DEPLOYMENT.md, Restore) using the same `NEXTAUTH_SECRET`.

## Queue unavailable

There is no external queue; the queue is the `email_jobs` table plus in-process loops. "Queue unavailable" means either the DB is down (see above) or the loops are not running (app crashed). Restart and confirm jobs progress:
```bash
docker compose exec linki node -e "process.exit(0)"   # container reachable
docker compose logs --tail=100 linki | grep -i runner
```

## Stuck jobs

Symptom: jobs sitting in `leased`, `sending`, or `uncertain`.
- `leased` past its lease is auto-requeued to `pending` by `recoverStaleEmailJobs()` on the next tick.
- `sending` past its lease becomes `uncertain` on recovery. This is deliberate: the provider may or may not have accepted the message, so it is not auto-retried to avoid a double-send.
- Reconcile `uncertain` jobs manually. Inspect and decide per job:
```bash
docker compose exec linki node -e "const {getDb}=require('./.next/server/chunks/…'); " # not stable; prefer the DB directly:
sqlite3 /opt/linki/data/linki.db "SELECT id, recipient, subject, last_error, updated_at FROM email_jobs WHERE status='uncertain';"
```
  For each, check the recipient inbox or the `sent_messages` table for a matching send. If it was not sent, requeue by setting `status='pending', available_at=datetime('now'), lease_owner=NULL`. If it was sent, mark `status='sent'`. Only do this after confirming, and back up first.

## Repeated failed jobs

Symptom: jobs in `failed` with a repeating error.
```bash
sqlite3 /opt/linki/data/linki.db "SELECT last_error, COUNT(*) FROM email_jobs WHERE status='failed' GROUP BY last_error ORDER BY 2 DESC;"
```
- Permanent errors (invalid credentials, suppressed recipient) should not be retried; fix the underlying cause (reconnect the mailbox, correct the address).
- Transient patterns that exhausted `max_attempts` can be requeued after fixing the cause.

## Expired LinkedIn session

Symptom: the account shows as not authenticated in Settings, and its campaigns log
"The LinkedIn account's session has expired — re-authenticate it in Settings."

What the system does on its own: the first step that lands on a LinkedIn sign-in page flags
the account and puts that account's LinkedIn steps on hold. No contact is failed for it, and
email steps in the same campaigns keep running. Held steps resume on the first tick after
the account is signed back in.

1. Do not attempt to bypass any security challenge.
2. In the app, re-authenticate the affected account (cookie paste or the login flow). This is an operator action. A pasted cookie is now checked against LinkedIn before the account is marked authenticated.
3. Use **Settings → LinkedIn → Check session** at any time to ask LinkedIn whether a session is still signed in, rather than trusting the stored flag.
4. Confirm the pinned Chromium was not changed by a rebuild, which is a common root cause of forced logout.

## Verifying the LinkedIn automation

LinkedIn changes its pages without notice, so the way to know a step works is to run it.
`POST /api/accounts/{id}/test` (admin; also the MCP tool `linkedin_account_manage` with
`action: "test"`) runs ONE action through the same code the campaign runner uses and
returns what LinkedIn showed:

| Body | What it does |
| --- | --- |
| `{"action":"session"}` | Is the session signed in? |
| `{"action":"inspect","url":"…/in/…"}` | Reads the profile: `connected`, `pending`, or `connectable` (and whether Connect was on the card or in the More menu). Sends nothing. |
| `{"action":"visit","url":"…"}` | Visits the profile. |
| `{"action":"connect","url":"…","note":"…","confirm":true}` | **Really sends** a connection request and confirms LinkedIn shows it as pending. |
| `{"action":"message","url":"…","text":"…","confirm":true}` | **Really sends** a message to a first-degree connection. |
| `{"action":"withdraw","url":"…","confirm":true}` | **Really withdraws** the pending invitation to that member and confirms the profile no longer shows it. LinkedIn then refuses a new invitation to them for about three weeks. |

Pass `contact_id` instead of `url` to act on a contact and record the result on it, so a
campaign does not repeat the step. After a LinkedIn layout change, `inspect` on one profile
of each kind is the fastest way to see what broke.

The same steps are also covered offline: `npm test` (page readers against saved markup,
step and runner logic with the browser scripted) and `npm run test:browser` (the steps
driving a real Chromium against a stand-in LinkedIn; needs `npx playwright install chromium`).

## Invitations nobody answered

A connect step waits `LINKEDIN_ACCEPT_WAIT_DAYS` (30) for an acceptance. When that runs out
the runner withdraws the invitation on LinkedIn and only then skips the contact, so
unanswered invitations do not pile up in the account's pending list (LinkedIn caps it, and
a large backlog counts against the account).

- It is browser activity: inside the account's working hours only, at most
  `LINKEDIN_DAILY_WITHDRAW_LIMIT` (10) per account per day, and on hold while the account
  is signed out. A run with contacts waiting on this stays `running` until they are done.
- The run log says which happened: `Invitation withdrawn — …`, or `… no invitation left on
  LinkedIn to withdraw` (declined, expired, or withdrawn by hand), or, after two retries,
  `… could not be withdrawn and is still pending on LinkedIn`. The contact is skipped as
  "Did not accept connection" in every case — a failed clean-up never fails a contact.
- The withdrawal date is kept on the contact (`targets.invite_withdrawn_at`). A later
  campaign's connect step for the same person waits until 21 days after it before
  inviting again, because LinkedIn would refuse the invitation before then.
- Contacts given up on before this existed are not revisited, and invitations sent by hand
  are never touched. `{"action":"withdraw"}` on the test endpoint withdraws one of those.

## Contacts wrongly marked as connected

Symptom: contacts show as connected that never accepted, or accepted contacts still wait.
Run **Settings → LinkedIn → Sync connections** (or `POST /api/accounts/{id}/sync-accepted`).
It reads the account's real connections list from LinkedIn and reconciles: accepted
invitations get LinkedIn's own acceptance date, and — only when the whole list was read and
matches LinkedIn's total — contacts marked connected that are not in it are un-marked. If
the response says `verified_complete: false`, nothing was un-marked; run it again.

## LinkedIn checkpoint

Symptom: LinkedIn presents a checkpoint, CAPTCHA, or security verification.
1. The system is designed to stop or pause the account on these conditions rather than push through. Leave it paused.
2. A human should resolve the checkpoint directly in a normal browser session for that account, then re-authenticate in the app.
3. Do not automate the challenge.

## Account restriction

Symptom: LinkedIn temporarily restricts the account or shows an unusual-activity warning.
1. Pause automation for that account.
2. Reduce that account's daily/hourly limits and pacing before resuming (limits are enforced by the runner; a human should lower the configured values).
3. Resume only after the restriction clears. Do not parallelize or increase throughput to "catch up".

## Failed deployment

Symptom: new image starts unhealthy or crash-loops.
1. `docker compose logs --tail=200 linki`.
2. If it is a config error, fix `.env.local` and retry.
3. If it is a code regression, roll back to the previous image tag (DEPLOYMENT.md, Roll back) and `docker compose up -d`.
4. The database is unchanged by a rollback because migrations are additive and idempotent.

## Failed migration

Migrations are idempotent `CREATE/ALTER` statements that run on boot; there is no destructive migration path. If boot fails during migration:
1. Read the exact SQL error in the logs.
2. Restore the pre-deploy database backup (DEPLOYMENT.md, Restore) and roll back to the previous image.
3. Report the failing statement for a code fix. Do not hand-edit the schema in production without a backup.

## Backup restoration

See DEPLOYMENT.md sections 11 and 12. Key points: stop the container, replace `linki.db`, remove stale `-wal`/`-shm`, start, and use the same `NEXTAUTH_SECRET` that was in effect when the backup was taken (otherwise encrypted sessions and secrets will not decrypt).

## Database growth (routine maintenance)

High-growth tables to prune on a schedule (back up first):
```bash
# Example: keep 90 days of event/log history. Review before running in production.
sqlite3 /opt/linki/data/linki.db "DELETE FROM logs WHERE created_at < datetime('now','-90 days');"
sqlite3 /opt/linki/data/linki.db "DELETE FROM domain_events WHERE occurred_at < datetime('now','-90 days');"
sqlite3 /opt/linki/data/linki.db "DELETE FROM sender_events WHERE occurred_at < datetime('now','-90 days');"
sqlite3 /opt/linki/data/linki.db "VACUUM;"
```
Do not delete from `accounts`, `runs`, `targets`, or session data. Run `VACUUM` during a quiet window; it rewrites the database file.

## What to watch (lightweight monitoring)

With no heavy observability stack, poll these on a small interval from the host or an external uptime monitor:
- `GET /api/health` (app up) and `GET /api/health?ready=1` (DB up).
- `docker inspect` health status (repeated unhealthy means restart-looping).
- `free -h` / `docker stats` (high memory, OOM risk).
- `df -h /` and `du -sh /opt/linki/data` (disk and DB growth).
- `email_jobs` counts by status (rising `failed`/`uncertain` means a provider or reconciliation problem).
- Accounts flagged as needing re-auth (LinkedIn checkpoints).
- Backup job success.
