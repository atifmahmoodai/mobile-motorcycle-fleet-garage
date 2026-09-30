# Operations guide

## Deploying

The app is one container (`Dockerfile`) that needs a PostgreSQL database. It works on any host that runs containers:

- **A single VPS** (Hetzner, DigitalOcean, Lightsail): use `docker compose up -d --build` with the included `docker-compose.yml`. Put Caddy or nginx in front for https.
- **Managed platforms** (Render, Railway, Fly.io, Google Cloud Run, AWS App Runner, Azure Container Apps): deploy the image and attach a managed PostgreSQL database. Set `DATABASE_URL` and the other variables from `.env.example`.

Checklist for going live:

1. **Environment:** `NODE_ENV=production`, and `PUBLIC_URL` set to the exact https address staff open.
2. **Proxy:** set `TRUST_PROXY=true` when a proxy or load balancer terminates https. Otherwise client IPs (rate limits, audit log) and https detection are wrong.
3. **Cookies:** leave `COOKIE_SECURE` unset, which means on in production. Browsers then only send the session cookie over https.
4. **Time zone:** set `TIMEZONE` to the garage's zone, e.g. `Europe/London`. Service due dates, report periods and invoice periods follow it.
5. **First admin:** create it with `node dist/cli/create-admin.js --email … --name …`. The password comes from `ADMIN_PASSWORD` or a hidden prompt.

The server runs pending database migrations on start-up. An advisory lock makes this safe with several replicas. To run them separately (e.g. as a release step), use `node dist/cli/migrate.js`.

### Reverse proxy example (Caddy)

```
garage.example.com {
  reverse_proxy app:8080
}
```

Caddy obtains and renews the https certificate automatically.

## Health checks

| Endpoint | Meaning | Use for |
|---|---|---|
| `GET /healthz` | Process is running | Liveness probe |
| `GET /readyz` | Database answers | Readiness probe / load balancer health check |

The Docker image has a `HEALTHCHECK` on `/readyz`.

## Logs and monitoring

- **Log format:** one JSON line per request (pino) with a request id. The id is also returned in the `x-request-id` header, so a user's error report can be matched to a log line.
- **Redaction:** cookies, CSRF tokens and authorization headers are removed from logs.
- **Alerts:** alert on repeated 5xx responses and on `/readyz` failing. Any log shipper works (Grafana Loki, Datadog, CloudWatch).
- **Activity log:** business actions (clients, bikes and odometer corrections, jobs created, signed off and cancelled, labour-time corrections, stock movements, invoices issued, paid and voided, settings and user changes, logins and failed logins) are in the `audit_log` table. Admins can view them under **Activity log**.

## Backups

All business data (clients, bikes, job history, photos, parts and stock movements, invoices and the activity log) is in PostgreSQL. Client contacts and job photos can be personal data: restrict who can read backups, and keep invoice records as long as tax law requires (often 5–10 years).

- **Managed databases** (RDS, Cloud SQL, Azure, Supabase, Neon): turn on automated backups with point-in-time recovery (7–30 days).
- **Self-hosted:** take a nightly logical dump and copy it off the server:

  ```bash
  docker compose exec -T db pg_dump -U fleet -Fc fleet > backup-$(date +%F).dump
  # restore into an empty database:
  docker compose exec -T db pg_restore -U fleet -d fleet --clean < backup-2026-09-29.dump
  ```

- **Test restores:** restore a backup to a scratch database regularly. A backup you've never restored is a guess.

## Upgrades

1. Take a backup.
2. Deploy the new image. Migrations run automatically, and each runs in a transaction, so a failed migration leaves the database unchanged and the app refuses to start.
3. Check `/readyz` and the logs.

## Scaling notes

- **Load:** a single instance comfortably handles a workshop with dozens of technicians and thousands of bikes. The database pool size is `DATABASE_POOL_MAX` (default 10).
- **Several instances:** they share the database, and sessions live in the database, so any instance can serve any user. Rate limits are per instance (in memory).
- **Housekeeping:** expired sessions are purged hourly.

## Security routines

- **Staff changes:** when someone leaves, untick **Active** under **Settings → Staff logins**. This signs them out everywhere.
- **Locked accounts:** they unlock after 15 minutes, or immediately when an admin resets the password.
- **Updates:** keep the base image current. Rebuild regularly and run `npm audit` in CI.

## Technician phones

- Technicians use the site on their phone (`/tech`); it can be added to the home screen. Actions (clock on/off, checklist, parts, notes, sign-off) are saved on the phone first and sent in order when there is signal. Each carries an id, so a retry never applies twice. Photos need a connection.
- If the server refuses a queued action (for example a part that has run out), the technician sees it under **Not saved** with the reason. It is not retried.
- Processed action ids are kept for 30 days, then purged.
- A shared phone keeps a separate queue per login. Signing out does not delete unsent actions; they send when the same person signs in again.
