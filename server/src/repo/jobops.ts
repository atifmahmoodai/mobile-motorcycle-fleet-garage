// Job actions shared by the manager screens and the technician app's sync endpoint, so the rules are
// the same whichever way a change arrives. Every function runs inside the caller's transaction and
// expects the job row to be locked (lockJob).
import { badRequest, HttpError } from "../http";
import { checklistProblems, failedSafetyItems, newChecklist, type CheckItem } from "../../../shared/fleet";
import type { CheckResult, SessionUser } from "../../../shared/schemas";
import type { Settings } from "../../../shared/types";
import type { Queryable } from "../db";
import { assertEditable, audit, lockJob, newId, nextNumber } from "./data";

type LockedJob = Awaited<ReturnType<typeof lockJob>>;

/** Opens or closes the bike's downtime interval to match the job's off-road flag. */
export async function syncDowntime(c: Queryable, jobId: string, bikeId: string, offRoad: boolean, at: Date) {
  if (offRoad) {
    await c.query(
      `INSERT INTO bike_downtime (bike_id, job_id, started_at) VALUES ($1, $2, $3)
       ON CONFLICT (job_id) WHERE ended_at IS NULL DO NOTHING`,
      [bikeId, jobId, at],
    );
  } else {
    await c.query("UPDATE bike_downtime SET ended_at = GREATEST($2, started_at) WHERE job_id = $1 AND ended_at IS NULL", [jobId, at]);
  }
}

async function stopRunning(c: Queryable, where: string, params: unknown[], at: Date) {
  // A stop time before the start (a phone clock that was wrong) ends the entry one minute in.
  await c.query(
    `UPDATE job_labour SET ended_at = GREATEST($${params.length + 1}::timestamptz, started_at + interval '1 minute')
      WHERE ended_at IS NULL AND ${where}`,
    [...params, at],
  );
}

export async function startTimer(c: Queryable, job: LockedJob, user: SessionUser, at: Date) {
  assertEditable(job);
  const running = await c.query<{ job_id: string }>("SELECT job_id FROM job_labour WHERE technician_id = $1 AND ended_at IS NULL", [user.id]);
  if (running.rows[0]?.job_id === job.id) return;
  // One clock per technician: starting here stops the other job's clock.
  await stopRunning(c, "technician_id = $1", [user.id], at);
  await c.query("INSERT INTO job_labour (id, job_id, technician_id, started_at) VALUES ($1, $2, $3, $4)", [newId("l"), job.id, user.id, at]);
  await c.query(
    `UPDATE jobs SET status = 'in_progress', started_at = COALESCE(started_at, $2),
            assigned_to = COALESCE(assigned_to, $3), version = version + 1, updated_at = now()
      WHERE id = $1`,
    [job.id, at, user.id],
  );
}

export async function stopTimer(c: Queryable, job: LockedJob, user: SessionUser, at: Date) {
  await stopRunning(c, "technician_id = $1 AND job_id = $2", [user.id, job.id], at);
}

export async function setCheck(c: Queryable, job: LockedJob, key: string, result: CheckResult | null, note: string) {
  assertEditable(job);
  const items: CheckItem[] = job.checklist;
  const i = items.findIndex((x) => x.key === key);
  if (i < 0) throw badRequest(`This job has no checklist item "${key}".`);
  items[i] = { ...items[i], result, note };
  await c.query("UPDATE jobs SET checklist = $2, version = version + 1, updated_at = now() WHERE id = $1", [job.id, JSON.stringify(items)]);
}

export async function addPart(c: Queryable, job: LockedJob, user: SessionUser, partId: string, qty: number) {
  assertEditable(job);
  const { rows } = await c.query<{ sku: string; name: string; stock_qty: number; cost_cents: number; price_cents: number; active: boolean; unit: string }>(
    "SELECT sku, name, stock_qty, cost_cents, price_cents, active, unit FROM parts WHERE id = $1 FOR UPDATE",
    [partId],
  );
  const p = rows[0];
  if (!p || !p.active) throw badRequest("That part isn't in the catalogue.");
  if (p.unit === "each" && !Number.isInteger(qty)) throw badRequest(`${p.sku} is counted in whole units.`);
  if (Number(p.stock_qty) < qty) {
    throw new HttpError(409, `Only ${Number(p.stock_qty)} of ${p.sku} ${p.name} in stock. Book in the delivery first.`, "out_of_stock");
  }
  const id = newId("jp");
  await c.query(
    "INSERT INTO job_parts (id, job_id, part_id, qty, unit_cost_cents, unit_price_cents, added_by) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [id, job.id, partId, qty, p.cost_cents, p.price_cents, user.id],
  );
  await c.query("UPDATE parts SET stock_qty = stock_qty - $2 WHERE id = $1", [partId, qty]);
  await c.query("INSERT INTO stock_moves (part_id, qty, reason, job_id, user_id) VALUES ($1, $2, 'job', $3, $4)", [partId, -qty, job.id, user.id]);
  return id;
}

export async function removePart(c: Queryable, job: LockedJob, user: SessionUser, jobPartId: string) {
  assertEditable(job);
  const { rows } = await c.query<{ part_id: string; qty: number }>("DELETE FROM job_parts WHERE id = $1 AND job_id = $2 RETURNING part_id, qty", [jobPartId, job.id]);
  if (!rows[0]) throw badRequest("That part isn't on this job.");
  await c.query("UPDATE parts SET stock_qty = stock_qty + $2 WHERE id = $1", [rows[0].part_id, rows[0].qty]);
  await c.query("INSERT INTO stock_moves (part_id, qty, reason, job_id, user_id) VALUES ($1, $2, 'job_removed', $3, $4)", [rows[0].part_id, rows[0].qty, job.id, user.id]);
}

export async function addNote(c: Queryable, job: LockedJob, user: SessionUser, text: string, at: Date) {
  await c.query("INSERT INTO job_notes (id, job_id, user_id, text, at) VALUES ($1, $2, $3, $4, $5)", [newId("n"), job.id, user.id, text, at]);
}

export async function setWaitingParts(c: Queryable, job: LockedJob, at: Date) {
  assertEditable(job);
  await stopRunning(c, "job_id = $1", [job.id], at);
  await c.query("UPDATE jobs SET status = 'waiting_parts', version = version + 1, updated_at = now() WHERE id = $1", [job.id]);
}

/** Signs a job off. Returns the id of a follow-up repair job when safety checks failed. */
export async function completeJob(
  c: Queryable,
  job: LockedJob,
  user: SessionUser,
  input: { odometerKm: number; summary: string },
  at: Date,
  today: string,
): Promise<string | null> {
  assertEditable(job);
  const items: CheckItem[] = job.checklist;
  const problems = checklistProblems(items);
  if (problems.length) throw new HttpError(400, problems.join(". "), "checklist_incomplete");
  const { rows } = await c.query<{ odometer_km: number; plate: string }>("SELECT odometer_km, plate FROM bikes WHERE id = $1 FOR UPDATE", [job.bike_id]);
  const bike = rows[0];
  if (input.odometerKm < bike.odometer_km) {
    throw badRequest(`The odometer can't go backwards: the last reading for ${bike.plate} was ${bike.odometer_km} km.`, { odometerKm: `At least ${bike.odometer_km}` });
  }
  await stopRunning(c, "job_id = $1", [job.id], at);
  const service = job.kind === "service";
  await c.query(
    `UPDATE bikes SET odometer_km = $2,
            last_service_km = CASE WHEN $3 THEN $2 ELSE last_service_km END,
            last_service_date = CASE WHEN $3 THEN $4::date ELSE last_service_date END,
            version = version + 1, updated_at = now()
      WHERE id = $1`,
    [job.bike_id, input.odometerKm, service, today],
  );
  await c.query(
    `UPDATE jobs SET status = 'done', completed_at = $2, odometer_km = $3, summary = $4, started_at = COALESCE(started_at, $2),
            version = version + 1, updated_at = now()
      WHERE id = $1`,
    [job.id, at, input.odometerKm, input.summary],
  );

  // Failed safety checks: the bike stays off the road under a follow-up repair job.
  const failed = failedSafetyItems(items);
  let followUp: string | null = null;
  if (failed.length) {
    followUp = newId("j");
    const number = await nextNumber(c, "job", "JB");
    const description = failed.map((f) => `${f.label}: ${f.note}`).join("\n");
    await c.query(
      `INSERT INTO jobs (id, number, bike_id, client_id, kind, priority, title, description, off_road, off_road_since, assigned_to, reported_by, follow_up_of, checklist)
       VALUES ($1, $2, $3, $4, 'repair', 'urgent', $5, $6, true, $7, $8, $8, $9, '[]')`,
      [followUp, number, job.bike_id, job.client_id, `Fix failed checks from ${job.number}`, description, at, user.id, job.id],
    );
    await syncDowntime(c, followUp, job.bike_id, true, at);
  }
  // Downtime ends when this job is done, unless the follow-up keeps the bike off the road
  // (its own interval starts at the same moment, so there is no gap).
  await syncDowntime(c, job.id, job.bike_id, false, at);
  await audit(c, { userId: user.id, action: "job.complete", entity: "job", entityId: job.id, details: { odometerKm: input.odometerKm, followUp } });
  return followUp;
}

export function checklistFor(kind: string, s: Settings): CheckItem[] {
  if (kind === "service") return newChecklist(s.serviceChecklist);
  if (kind === "inspection") return newChecklist(s.inspectionChecklist);
  return [];
}

/** Accepts a phone's timestamp if it is plausible; anything else uses the server's clock. */
export function opTime(at: string, now = new Date()): Date {
  const t = new Date(at);
  const age = now.getTime() - t.getTime();
  if (Number.isNaN(t.getTime()) || age > 48 * 3600_000 || age < -5 * 60_000) return now;
  return t;
}
