import type { FastifyInstance } from "fastify";
import { todayIn } from "../config";
import { badRequest, requireUser } from "../http";
import { coveredHours, serviceDue } from "../../../shared/fleet";
import { toCsv } from "../../../shared/csv";
import { getSettings } from "../repo/data";
import type { Dashboard } from "../../../shared/types";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function reportRoutes(app: FastifyInstance) {
  const staff = requireUser("admin", "manager", "technician");
  const managers = requireUser("admin", "manager");
  const tz = () => app.config.TIMEZONE;

  app.get("/dashboard", { preHandler: staff }, async (): Promise<Dashboard> => {
    const today = todayIn(tz());
    const settings = await getSettings(app.db);
    const [byStatus, unassigned, offRoad, bikes, timers, low, doneToday] = await Promise.all([
      app.db.query<{ status: string; n: number }>("SELECT status, count(*)::int AS n FROM jobs WHERE status IN ('open', 'scheduled', 'in_progress', 'waiting_parts') GROUP BY status"),
      app.db.query<{ n: number }>("SELECT count(*)::int AS n FROM jobs WHERE assigned_to IS NULL AND status IN ('open', 'scheduled', 'in_progress', 'waiting_parts')"),
      app.db.query(
        `SELECT DISTINCT ON (b.id) b.id AS "bikeId", b.plate, c.name AS "clientName", j.off_road_since AS since, j.number AS "jobNumber", j.id AS "jobId"
           FROM jobs j JOIN bikes b ON b.id = j.bike_id JOIN clients c ON c.id = j.client_id
          WHERE j.off_road AND j.status IN ('open', 'scheduled', 'in_progress', 'waiting_parts')
          ORDER BY b.id, j.off_road_since`,
      ),
      app.db.query("SELECT odometer_km, last_service_km, last_service_date, service_interval_km, service_interval_days FROM bikes WHERE NOT retired"),
      app.db.query(
        `SELECT u.name AS "technicianName", j.id AS "jobId", j.number AS "jobNumber", b.plate, l.started_at AS "startedAt"
           FROM job_labour l JOIN users u ON u.id = l.technician_id JOIN jobs j ON j.id = l.job_id JOIN bikes b ON b.id = j.bike_id
          WHERE l.ended_at IS NULL ORDER BY l.started_at`,
      ),
      app.db.query(`SELECT id, sku, name, stock_qty AS "stockQty", min_qty AS "minQty" FROM parts WHERE active AND stock_qty <= min_qty ORDER BY name LIMIT 20`),
      app.db.query<{ n: number }>("SELECT count(*)::int AS n FROM jobs WHERE status = 'done' AND (completed_at AT TIME ZONE $1)::date = $2", [tz(), today]),
    ]);
    const due = { overdue: 0, dueSoon: 0 };
    for (const b of bikes.rows) {
      const d = serviceDue(
        { odometerKm: b.odometer_km, lastServiceKm: b.last_service_km, lastServiceDate: b.last_service_date, serviceIntervalKm: b.service_interval_km, serviceIntervalDays: b.service_interval_days },
        today,
        { km: settings.dueSoonKm, days: settings.dueSoonDays },
      );
      if (d.status === "overdue") due.overdue++;
      else if (d.status === "due_soon") due.dueSoon++;
    }
    return {
      jobsByStatus: Object.fromEntries(byStatus.rows.map((r) => [r.status, r.n])),
      unassigned: unassigned.rows[0].n,
      offRoadBikes: offRoad.rows.map((r) => ({ ...r, since: (r.since as Date).toISOString() })),
      dueCounts: due,
      runningTimers: timers.rows.map((r) => ({ ...r, startedAt: (r.startedAt as Date).toISOString() })),
      lowStock: low.rows,
      completedToday: doneToday.rows[0].n,
    };
  });

  /** Period reports: work done, technicians, client availability and parts. ?format=csv&table=… for a download. */
  app.get<{ Querystring: { from?: string; to?: string; format?: string; table?: string } }>("/reports", { preHandler: managers }, async (req, reply) => {
    const { from = "", to = "" } = req.query;
    if (!DATE.test(from) || !DATE.test(to) || from > to) throw badRequest("Choose a valid period.", { from: "YYYY-MM-DD" });
    const params = [from, to, tz()];
    const inPeriod = "(j.completed_at AT TIME ZONE $3)::date BETWEEN $1 AND $2";
    const [summary, techs, clients, parts] = await Promise.all([
      app.db.query(
        `SELECT count(*)::int AS "jobsDone",
                round(avg(extract(epoch FROM j.completed_at - j.created_at) / 3600)::numeric, 1)::float AS "avgTurnaroundHours",
                count(*) FILTER (WHERE j.kind = 'service')::int AS services,
                count(*) FILTER (WHERE j.source = 'client')::int AS "clientDefects"
           FROM jobs j WHERE j.status = 'done' AND ${inPeriod}`,
        params,
      ),
      app.db.query(
        `SELECT u.name AS technician,
                round(sum(extract(epoch FROM l.ended_at - l.started_at)) / 3600, 1)::float AS "labourHours",
                count(DISTINCT l.job_id)::int AS jobs
           FROM job_labour l JOIN users u ON u.id = l.technician_id
          WHERE l.ended_at IS NOT NULL AND (l.started_at AT TIME ZONE $3)::date BETWEEN $1 AND $2
          GROUP BY u.name ORDER BY "labourHours" DESC`,
        params,
      ),
      app.db.query(
        `SELECT c.id, c.name AS client,
                (SELECT count(*) FROM bikes b WHERE b.client_id = c.id AND NOT b.retired)::int AS bikes,
                (SELECT count(*) FROM jobs j WHERE j.client_id = c.id AND j.status = 'done' AND ${inPeriod})::int AS "jobsDone",
                COALESCE((SELECT sum(i.total_cents) FROM invoices i WHERE i.client_id = c.id AND i.status <> 'void'
                           AND (i.issued_at AT TIME ZONE $3)::date BETWEEN $1 AND $2), 0)::int AS "invoicedCents"
           FROM clients c WHERE c.active ORDER BY c.name`,
        params,
      ),
      app.db.query(
        `SELECT p.sku, p.name, sum(jp.qty)::float AS qty, sum(jp.qty * jp.unit_price_cents)::int AS "salesCents"
           FROM job_parts jp JOIN parts p ON p.id = jp.part_id JOIN jobs j ON j.id = jp.job_id
          WHERE j.status = 'done' AND ${inPeriod}
          GROUP BY p.sku, p.name ORDER BY qty DESC LIMIT 20`,
        params,
      ),
    ]);

    // Availability: share of bike-hours in the period that bikes could be ridden.
    const start = Date.parse(`${from}T00:00:00Z`);
    const end = Date.parse(`${to}T00:00:00Z`) + 86_400_000;
    const periodHours = (end - start) / 3_600_000;
    const down = await app.db.query<{ bike_id: string; client_id: string; started_at: Date; ended_at: Date | null }>(
      `SELECT d.bike_id, b.client_id, d.started_at, d.ended_at FROM bike_downtime d JOIN bikes b ON b.id = d.bike_id
        WHERE d.started_at < $2 AND COALESCE(d.ended_at, now()) > $1`,
      [new Date(start), new Date(end)],
    );
    const now = Date.now();
    const byBike = new Map<string, { client: string; intervals: { start: number; end: number | null }[] }>();
    for (const d of down.rows) {
      const e = byBike.get(d.bike_id) ?? { client: d.client_id, intervals: [] };
      e.intervals.push({ start: d.started_at.getTime(), end: d.ended_at ? d.ended_at.getTime() : null });
      byBike.set(d.bike_id, e);
    }
    const downByClient = new Map<string, number>();
    for (const b of byBike.values()) downByClient.set(b.client, (downByClient.get(b.client) ?? 0) + coveredHours(b.intervals, start, end, now));
    const clientRows = clients.rows.map((c) => {
      const hours = downByClient.get(c.id) ?? 0;
      const possible = c.bikes * periodHours;
      return {
        client: c.client,
        bikes: c.bikes,
        jobsDone: c.jobsDone,
        downtimeHours: Math.round(hours * 10) / 10,
        availabilityPct: possible ? Math.round((1 - hours / possible) * 1000) / 10 : null,
        invoicedCents: c.invoicedCents,
      };
    });

    const tables = { technicians: techs.rows, clients: clientRows, parts: parts.rows };
    if (req.query.format === "csv") {
      const name = (req.query.table ?? "clients") as keyof typeof tables;
      if (!(name in tables)) throw badRequest("Unknown table.");
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="${name}-${from}-to-${to}.csv"`)
        .send(csvOf(tables[name] as Record<string, string | number | null>[]));
    }
    return { from, to, summary: summary.rows[0], ...tables };
  });
}

function csvOf(rows: Record<string, string | number | null>[]): string {
  const cols = rows.length ? Object.keys(rows[0]) : [];
  return toCsv(cols, rows.map((r) => cols.map((c) => r[c])));
}
