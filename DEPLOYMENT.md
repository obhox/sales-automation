# Linki Deployment Guide

Target: a single Linux VPS with 8 GB RAM and 100 GB storage running Docker and Docker Compose. Linki runs as one container that serves the web app, API, MCP server, background workers, and Chromium-based LinkedIn automation.

## 1. Prepare the VPS

- Install Docker Engine and the Docker Compose plugin.
- Create a deploy directory and a `data/` subdirectory (the SQLite database lives there and must persist across container recreation):
  ```bash
  mkdir -p /opt/linki/data && cd /opt/linki
  ```
- Put `docker-compose.yml` in `/opt/linki`.
- Front the app with a host-level reverse proxy (nginx, Caddy, or Traefik) terminating TLS and forwarding to `127.0.0.1:${PORT}`. The container binds to loopback only; do not expose it directly.

## 2. Configure environment variables

Create `/opt/linki/.env.local` from `.env.example`. It is read by compose via `env_file` and must never be committed or baked into an image (it is gitignored and dockerignored).

Required in production:
- `NEXTAUTH_SECRET` (generate with `openssl rand -base64 32`). The app fails fast at startup if this is missing.
- `NEXTAUTH_URL` (your public HTTPS URL).

Recommended:
- `INTERNAL_API_SECRET` (generate with `openssl rand -base64 32`) if the MCP endpoint is used.

Optional: `EMAIL_TRACKING_BASE_URL`, `EMAIL_TRACKING_SECRET`, `MCP_ALLOWED_ORIGINS`, `HEADLESS`. `LINKI_DB_PATH` is set to `/data/linki.db` by compose automatically.

## 3. Build or pull the containers

The compose file uses the published image by default:
```bash
docker compose pull
```
To build from source instead, edit `docker-compose.yml` to comment out `image:` and uncomment `build: .`, then:
```bash
docker compose build
```
Note: the Dockerfile pins Chromium and the base image deliberately (LinkedIn fingerprint stability). Do not unpin them.

## 4. Start the application

```bash
docker compose up -d
```

## 5. Migrations

No manual migration step is required. Schema creation and idempotent migrations run in-process on boot from `lib/db.ts`. The first start creates `/data/linki.db`.

## 6. Verify health

```bash
# Liveness
curl -fsS http://127.0.0.1:${PORT:-3456}/api/health
# Readiness (includes a DB check)
curl -fsS "http://127.0.0.1:${PORT:-3456}/api/health?ready=1"
# Container health status
docker compose ps
docker inspect --format '{{.State.Health.Status}}' $(docker compose ps -q linki)
```
Expect `{"status":"ok",...}` and, for readiness, `"db":"up"`. The container should report `healthy` within ~40 seconds of start.

## 7. View logs

```bash
docker compose logs -f linki
```
Logs are capped at 10 MB per file, 5 files (50 MB total) by the compose `logging` config.

## 8. Restart safely

```bash
docker compose restart linki
```
In-flight email jobs are safe: a job mid-provider-handoff is recovered as `uncertain` on restart rather than re-sent. The LinkedIn loop resumes from durable run state. Restarts are safe with respect to the encrypted sessions in `/data`.

## 9. Update the application

```bash
cd /opt/linki
docker compose pull            # or: docker compose build
docker compose up -d
docker compose ps              # confirm healthy
```
Because `/data` is a bind mount, the database survives the container recreation.

## 10. Roll back

```bash
# Pin to a previous known-good image tag in docker-compose.yml, then:
docker compose up -d
```
Keep the previous image tag noted before each update. The database schema only grows via idempotent migrations, so an older app image runs against the same `/data/linki.db` without a downgrade step.

## 11. Back up data

The entire application state is the SQLite database plus its WAL/SHM siblings.
```bash
# Consistent online backup (preferred; requires sqlite3 on the host):
sqlite3 /opt/linki/data/linki.db ".backup '/opt/linki/backups/linki-$(date +%F).db'"

# Or stop-copy-start for a cold backup:
docker compose stop linki
cp /opt/linki/data/linki.db /opt/linki/backups/linki-$(date +%F).db
docker compose start linki
```
Back up `linki.db`, `linki.db-wal`, and `linki.db-shm` together if copying cold. Store backups off-box. These files contain encrypted LinkedIn sessions and lead data; protect them accordingly.

## 12. Restore data

```bash
docker compose stop linki
cp /opt/linki/backups/linki-YYYY-MM-DD.db /opt/linki/data/linki.db
rm -f /opt/linki/data/linki.db-wal /opt/linki/data/linki.db-shm
docker compose start linki
```
Restore requires the same `NEXTAUTH_SECRET` used when the backup was taken, or the encrypted sessions and secrets will not decrypt.

## 13. Clean Docker resources safely

```bash
docker image prune -f            # dangling images
docker builder prune -f          # build cache
```
Do not run `docker volume prune` or delete the `data/` bind mount; that is the database. Never `docker compose down -v`.

## 14. Monitor RAM and disk

```bash
docker stats --no-stream         # container memory/CPU
free -h                          # host memory
df -h /                          # host disk
du -sh /opt/linki/data           # database size growth
```

## Resource recommendations for the 8 GB VPS

These are grounded in the actual architecture: one Node process, one SQLite connection, and Chromium driven by a single sequential leased loop (so at most one browser context is active at a time).

| Resource | Recommended | Rationale |
| --- | --- | --- |
| App server processes | 1 (`next start`) | The app is a single Node process; workers run in-process. Do not run multiple app replicas against one SQLite file. |
| Background worker concurrency | 1 per loop type (built in) | Each subsystem loop is leased and sequential; email dispatch handles up to 20 pending jobs per 30 s tick, sent sequentially. |
| Max simultaneous Chromium sessions | 1 | The LinkedIn loop is single-flight by design. Do not parallelize. |
| Database connection pool | N/A (1 shared connection) | better-sqlite3 is synchronous; a single connection with WAL is correct for one host. |
| Container memory limit | 6 GB (optional, opt-in) | Leaves ~1 GB for OS + Docker daemon and ~1 GB free reserve. Chromium can spike to ~1 to 1.5 GB on heavy pages; 6 GB gives ample headroom. |
| Minimum free memory reserve | ~1 GB | Prevents swapping and OOM under a Chromium spike. |
| Log retention | 50 MB/container (set) | json-file `max-size: 10m` x `max-file: 5`. |
| Database growth | Prune periodically | See OPERATIONS_RUNBOOK.md for pruning `logs`, `domain_events`, `sender_events`, and completed `email_jobs`. |

### Applying container memory/CPU limits (optional)

Resource limits are intentionally not set in the shipped `docker-compose.yml` because a too-tight `mem_limit` would OOM-kill Chromium mid-session and force a LinkedIn re-authentication. If you choose to apply them, use generous headroom and monitor `docker stats` for a few days first:

```yaml
    # Add under the linki service, only after observing real usage:
    deploy:
      resources:
        limits:
          memory: 6g
    # For non-swarm compose, the equivalent top-level keys are:
    # mem_limit: 6g
    # cpus: "3.5"
```

Do not go below roughly 4 GB: a single Chromium session plus the Node app can transiently need 2 to 2.5 GB, and headroom absorbs page-load spikes. Swap can be enabled as an emergency backstop only; it is not a substitute for headroom and will slow the browser noticeably if hit.
