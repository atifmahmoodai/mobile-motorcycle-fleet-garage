# Motorcycle Fleet Garage

Workshop software for a garage that maintains delivery and courier motorcycle fleets. It has three parts: a **technician phone app** that keeps working without signal, a **manager dashboard** for jobs, bikes, parts and invoicing, and a **client portal** where each fleet sees its own bikes and reports problems.

**Project guide (PDF):** [docs/PROJECT-GUIDE.pdf](docs/PROJECT-GUIDE.pdf) explains what this project is, the business problem it solves, the client's requirements, and how to build it from scratch, step by step.

![Dashboard](docs/screenshots/dashboard.png)

## What it does

**For technicians (on their phone, `/tech`)**
- My jobs and unassigned jobs; starting the clock on an unassigned job takes it.
- One clock per technician: starting a job stops the previous one.
- Pass / Fail / N/A checklist; a failure needs a note.
- Add parts from stock, write notes, take photos, mark "waiting for parts", and sign off with the odometer.
- **Offline first:** every action is saved on the phone and sent in order when there's signal. Each action has its own id, so a flaky connection never applies it twice. If the server refuses one (a part has run out, say), it shows under "Not saved" with the reason.

**For managers**
- Dashboard: bikes off the road and for how long, running clocks, services due, low stock.
- Jobs: service, inspection, repair or defect, with priority, booking date and technician.
- Time entries can be corrected until the job is invoiced, and every correction is logged.
- Bikes: services come due by distance or time, whichever is first. Odometer readings can't go backwards.
- **Failed safety checks keep the bike off the road** under an automatic urgent follow-up repair.
- Parts: deliveries, returns and stock-takes. Stock can't go negative, and the move history shows who used what, on which job.
- Invoicing: per client and period, with a preview before issuing.
  - Labour is billed at the client's agreed rate (or the default) in configurable blocks, plus parts and tax.
  - Numbering is gapless, and the same job can't be billed twice.
  - Voiding keeps the number and frees the jobs.
- Reports: fleet availability per client (off-road hours merged per bike), technician hours, parts used, turnaround. Each exports to CSV.

**For fleet clients**
- Their bikes only, with service status and what's off the road.
- They can report a problem, flagging "unsafe to ride" to make it urgent and off the road.
- They can follow jobs, read the work done and see their invoices.
- They never see part costs, workshop notes or other clients.

| Technician phone | Job | Invoice |
| --- | --- | --- |
| ![Technician](docs/screenshots/tech-phone.png) | ![Job](docs/screenshots/job.png) | ![Invoice](docs/screenshots/invoice.png) |

## Run it

```bash
cp .env.example .env            # set POSTGRES_PASSWORD, PUBLIC_URL, TIMEZONE
docker compose up -d --build
docker compose exec app node dist/cli/create-admin.js --email you@garage.com --name "Your Name"
```

To try it with demo data instead: `docker compose exec -e ALLOW_DEMO_SEED=1 app node dist/cli/seed-demo.js`. Then log in as `admin@demo.local`, `manager@demo.local`, `tech@demo.local` or `client@demo.local`. The password is `demo-password-1`.

Development (Node 22, PostgreSQL 16):

```bash
npm install
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/fleet
npm run migrate && npm run seed:demo
npm run dev                     # API on :8080, web on :5173
```

Operations (backups, https, updates, monitoring) are covered in [docs/OPERATIONS.md](docs/OPERATIONS.md).

## How it's built

- **Server:** Fastify 5, PostgreSQL, zod validation shared with the web app.
- **Web:** React 19, TanStack Query and Vite. One Docker image serves both.
- **Security:**
  - Passwords are hashed with scrypt, and repeated failures lock the account.
  - Sessions are stored as hashes, with CSRF tokens and an origin check.
  - Helmet CSP and rate limits are on.
  - Client scoping is enforced on every query.
  - Uploads are checked by their real bytes, not their name.
  - CSV exports are protected against formula injection.
- **Integrity in the database:**
  - One running clock per technician.
  - Registrations are unique among bikes in service.
  - Stock can't go below zero.
  - A client login always belongs to exactly one client.
  - Invoice totals must add up.
  - Job and invoice numbers are gapless.
  - Optimistic locking stops two people overwriting each other's edits.

## Tests

- `npm test` runs:
  - unit tests for the service-due, checklist, labour-billing and downtime rules;
  - 21 API tests against a real PostgreSQL database, covering access control, idempotent replay, one clock per technician, sign-off rules and follow-ups, stock, invoicing and voiding, and uploads.
- `npm run smoke` drives the built app in Chromium through a manager's day, a technician on a phone (losing signal mid-job and syncing afterwards), a client reporting a problem, an invoice run and phone layouts.
