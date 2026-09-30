import { randomUUID } from "node:crypto";
import type { Queryable } from "../db";
import { HttpError, notFound } from "../http";
import { DEFAULT_SETTINGS, serviceDue, type CheckItem } from "../../../shared/fleet";
import type { Role, SessionUser } from "../../../shared/schemas";
import type { Bike, Job, JobDetail, Settings } from "../../../shared/types";

export const newId = (prefix: string) => `${prefix}-${randomUUID()}`;

/** Part costs and margins are management information. */
export const seesCost = (role: Role) => role === "admin" || role === "manager";
export const isStaff = (role: Role) => role !== "client";

// ---- settings, audit, numbering ----

export async function getSettings(c: Queryable): Promise<Settings> {
  const { rows } = await c.query<{ value: Partial<Settings> }>("SELECT value FROM settings WHERE key = 'app'");
  return { ...DEFAULT_SETTINGS, ...(rows[0]?.value ?? {}) };
}

export async function saveSettings(c: Queryable, s: Settings) {
  await c.query("INSERT INTO settings (key, value) VALUES ('app', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()", [JSON.stringify(s)]);
}

export async function audit(
  c: Queryable,
  e: { userId: string | null; action: string; entity: string; entityId?: string | null; details?: Record<string, unknown>; ip?: string | null },
) {
  await c.query("INSERT INTO audit_log (user_id, action, entity, entity_id, details, ip) VALUES ($1, $2, $3, $4, $5, $6)", [
    e.userId,
    e.action,
    e.entity,
    e.entityId ?? null,
    JSON.stringify(e.details ?? {}),
    e.ip ?? null,
  ]);
}

/** Next number in a gapless series (JB-000123). Run inside the transaction that uses it. */
export async function nextNumber(c: Queryable, series: string, prefix: string): Promise<string> {
  const { rows } = await c.query<{ value: number }>(
    `INSERT INTO counters (name, value) VALUES ($1, 1)
     ON CONFLICT (name) DO UPDATE SET value = counters.value + 1
     RETURNING value`,
    [series],
  );
  return `${prefix}-${String(rows[0].value).padStart(6, "0")}`;
}

// ---- bikes ----

export const BIKE_SELECT = `
  SELECT b.*, c.name AS client_name,
         (SELECT count(*) FROM jobs j WHERE j.bike_id = b.id AND j.status IN ('open', 'scheduled', 'in_progress', 'waiting_parts'))::int AS open_jobs,
         EXISTS (SELECT 1 FROM jobs j WHERE j.bike_id = b.id AND j.off_road AND j.status IN ('open', 'scheduled', 'in_progress', 'waiting_parts')) AS is_off_road
    FROM bikes b JOIN clients c ON c.id = b.client_id`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toBike(r: any, today: string, s: Settings): Bike {
  const bike = {
    id: r.id,
    clientId: r.client_id,
    clientName: r.client_name,
    plate: r.plate,
    vin: r.vin,
    make: r.make,
    model: r.model,
    year: r.year,
    engineCc: r.engine_cc,
    odometerKm: r.odometer_km,
    serviceIntervalKm: r.service_interval_km,
    serviceIntervalDays: r.service_interval_days,
    lastServiceKm: r.last_service_km,
    lastServiceDate: r.last_service_date,
    notes: r.notes,
    retired: r.retired,
    version: r.version,
    openJobs: r.open_jobs,
    offRoad: r.is_off_road,
  };
  return { ...bike, due: serviceDue(bike, today, { km: s.dueSoonKm, days: s.dueSoonDays }) };
}

/** A client login can only reach its own client's bikes and jobs. */
export function assertCanSee(user: SessionUser, clientId: string) {
  if (user.role === "client" && user.clientId !== clientId) throw notFound();
}

// ---- jobs ----

export const JOB_SELECT = `
  SELECT j.*, b.plate, b.make || ' ' || b.model AS bike_name, c.name AS client_name, u.name AS assigned_name, i.number AS invoice_number
    FROM jobs j
    JOIN bikes b ON b.id = j.bike_id
    JOIN clients c ON c.id = j.client_id
    LEFT JOIN users u ON u.id = j.assigned_to
    LEFT JOIN invoices i ON i.id = j.invoice_id`;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toJob(r: any): Job {
  return {
    id: r.id,
    number: r.number,
    bikeId: r.bike_id,
    plate: r.plate,
    bikeName: r.bike_name,
    clientId: r.client_id,
    clientName: r.client_name,
    kind: r.kind,
    priority: r.priority,
    status: r.status,
    title: r.title,
    description: r.description,
    source: r.source,
    offRoad: r.off_road,
    scheduledFor: r.scheduled_for,
    assignedTo: r.assigned_to,
    assignedName: r.assigned_name,
    createdAt: iso(r.created_at)!,
    startedAt: iso(r.started_at),
    completedAt: iso(r.completed_at),
    invoiceNumber: r.invoice_number,
    version: r.version,
  };
}

/** Locks and returns the job row for an update in this transaction. */
export async function lockJob(c: Queryable, id: string) {
  const { rows } = await c.query("SELECT * FROM jobs WHERE id = $1 FOR UPDATE", [id]);
  if (!rows[0]) throw notFound("Job not found");
  return rows[0] as {
    id: string;
    number: string;
    bike_id: string;
    client_id: string;
    kind: string;
    status: string;
    off_road: boolean;
    assigned_to: string | null;
    checklist: CheckItem[];
    invoice_id: string | null;
    version: number;
    started_at: Date | null;
  };
}

export function assertEditable(job: { status: string; number: string }) {
  if (job.status === "done" || job.status === "cancelled") {
    throw new HttpError(409, `${job.number} is ${job.status === "done" ? "finished" : "cancelled"} and can't be changed.`, "job_closed");
  }
}

export async function loadJobDetail(c: Queryable, id: string, viewer: SessionUser): Promise<JobDetail> {
  const { rows } = await c.query(`${JOB_SELECT} WHERE j.id = $1`, [id]);
  const r = rows[0];
  if (!r) throw notFound("Job not found");
  assertCanSee(viewer, r.client_id);
  const [labour, parts, notes, photos] = await Promise.all([
    c.query(
      `SELECT l.id, l.technician_id, u.name, l.started_at, l.ended_at,
              CASE WHEN l.ended_at IS NULL THEN NULL ELSE round(extract(epoch FROM l.ended_at - l.started_at) / 60)::int END AS minutes
         FROM job_labour l JOIN users u ON u.id = l.technician_id WHERE l.job_id = $1 ORDER BY l.started_at`,
      [id],
    ),
    c.query(
      `SELECT jp.id, jp.part_id, p.sku, p.name, p.unit, jp.qty, jp.unit_price_cents, jp.unit_cost_cents
         FROM job_parts jp JOIN parts p ON p.id = jp.part_id WHERE jp.job_id = $1 ORDER BY jp.added_at`,
      [id],
    ),
    viewer.role === "client"
      ? Promise.resolve({ rows: [] })
      : c.query(`SELECT n.id, n.at, n.text, COALESCE(u.name, 'Unknown') AS author FROM job_notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.job_id = $1 ORDER BY n.at`, [id]),
    c.query("SELECT id, name, size, added_at FROM job_photos WHERE job_id = $1 ORDER BY added_at", [id]),
  ]);
  const cost = seesCost(viewer.role);
  const labourEntries = labour.rows.map((l) => ({
    id: l.id,
    technicianId: l.technician_id,
    technicianName: l.name,
    startedAt: iso(l.started_at)!,
    endedAt: iso(l.ended_at),
    minutes: l.minutes,
  }));
  return {
    ...toJob(r),
    odometerKm: r.odometer_km,
    summary: r.summary,
    checklist: r.checklist,
    labour: labourEntries,
    labourMinutes: labourEntries.reduce((t, l) => t + (l.minutes ?? 0), 0),
    parts: parts.rows.map((p) => ({
      id: p.id,
      partId: p.part_id,
      sku: p.sku,
      name: p.name,
      unit: p.unit,
      qty: p.qty,
      unitPriceCents: p.unit_price_cents,
      ...(cost ? { unitCostCents: p.unit_cost_cents } : {}),
    })),
    notes: notes.rows.map((n) => ({ id: n.id, at: iso(n.at)!, author: n.author, text: n.text })),
    photos: photos.rows.map((p) => ({ id: p.id, name: p.name, size: p.size, addedAt: iso(p.added_at)! })),
    myTimerStartedAt: labourEntries.find((l) => l.technicianId === viewer.id && !l.endedAt)?.startedAt ?? null,
    followUpOf: r.follow_up_of,
  };
}
