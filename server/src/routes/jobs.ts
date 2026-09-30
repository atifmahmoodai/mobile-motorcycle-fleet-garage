import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { todayIn } from "../config";
import { tx } from "../db";
import { badRequest, conflict, HttpError, notFound, parse, requireUser } from "../http";
import { assertCanSee, assertEditable, audit, getSettings, JOB_SELECT, loadJobDetail, lockJob, newId, nextNumber, toJob } from "../repo/data";
import { addNote, addPart, checklistFor, completeJob, removePart, setCheck, setWaitingParts, startTimer, stopTimer, syncDowntime } from "../repo/jobops";
import { CHECK_RESULTS, defectReportSchema, jobCreateSchema, jobUpdateSchema, labourEditSchema } from "../../../shared/schemas";

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

/** The real image type from the file's first bytes; the browser's claimed type is not trusted. */
export function sniffImage(buf: Buffer): string | null {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}
const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

const checkSchema = z.object({ key: z.string().max(40), result: z.enum(CHECK_RESULTS).nullable(), note: z.string().trim().max(300) });
const partAddSchema = z.object({ partId: z.string().min(1).max(64), qty: z.number().positive().max(1000) });
const noteSchema = z.object({ text: z.string().trim().min(1).max(2000) });
const completeSchema = z.object({ odometerKm: z.number().int().min(0).max(2_000_000), summary: z.string().trim().max(2000) });
const cancelSchema = z.object({ reason: z.string().trim().min(3, "Say why").max(300) });

export async function jobRoutes(app: FastifyInstance) {
  const anyone = requireUser();
  const staff = requireUser("admin", "manager", "technician");
  const managers = requireUser("admin", "manager");
  const uid = (req: FastifyRequest) => req.session!.user.id;
  const detail = (req: FastifyRequest, id: string) => loadJobDetail(app.db, id, req.session!.user);

  async function assertAssignable(assignedTo: string | null) {
    if (!assignedTo) return;
    const { rows } = await app.db.query("SELECT 1 FROM users WHERE id = $1 AND active AND role IN ('technician', 'manager', 'admin')", [assignedTo]);
    if (!rows[0]) throw badRequest("Jobs can only be assigned to active workshop staff.", { assignedTo: "Not a technician" });
  }

  app.get<{ Querystring: { status?: string; clientId?: string; bikeId?: string; assigned?: string; q?: string; before?: string } }>(
    "/jobs",
    { preHandler: anyone },
    async (req) => {
      const u = req.session!.user;
      const status = req.query.status ?? "open";
      const statuses = status === "open" ? ["open", "scheduled", "in_progress", "waiting_parts"] : status === "done" ? ["done"] : status === "cancelled" ? ["cancelled"] : null;
      const clientId = u.role === "client" ? u.clientId : req.query.clientId || null;
      const assigned = req.query.assigned === "me" ? u.id : req.query.assigned === "none" ? "" : null;
      const q = (req.query.q ?? "").trim().toUpperCase().slice(0, 40);
      const { rows } = await app.db.query(
        `${JOB_SELECT}
          WHERE ($1::text[] IS NULL OR j.status = ANY($1))
            AND ($2::text IS NULL OR j.client_id = $2)
            AND ($3::text IS NULL OR j.bike_id = $3)
            AND ($4::text IS NULL OR ($4 = '' AND j.assigned_to IS NULL) OR j.assigned_to = $4)
            AND ($5 = '' OR j.number LIKE '%' || $5 || '%' OR b.plate LIKE '%' || replace($5, ' ', '') || '%' OR upper(j.title) LIKE '%' || $5 || '%')
          ORDER BY CASE j.priority WHEN 'urgent' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, j.created_at DESC
          LIMIT 300`,
        [statuses, clientId, req.query.bikeId || null, assigned, q.replace(/[%_\\]/g, "")],
      );
      return { items: rows.map(toJob) };
    },
  );

  app.get<{ Params: { id: string } }>("/jobs/:id", { preHandler: anyone }, async (req) => detail(req, req.params.id));

  async function createJob(
    req: FastifyRequest,
    input: { bikeId: string; kind: string; priority: string; title: string; description: string; offRoad: boolean; scheduledFor: string | null; assignedTo: string | null },
    source: "workshop" | "client",
  ) {
    const settings = await getSettings(app.db);
    return tx(app.db, async (c) => {
      const { rows } = await c.query<{ client_id: string; retired: boolean; plate: string }>("SELECT client_id, retired, plate FROM bikes WHERE id = $1", [input.bikeId]);
      const bike = rows[0];
      if (!bike) throw badRequest("That bike doesn't exist.", { bikeId: "Unknown bike" });
      assertCanSee(req.session!.user, bike.client_id);
      if (bike.retired) throw badRequest(`${bike.plate} is retired.`, { bikeId: "Retired" });
      const id = newId("j");
      const number = await nextNumber(c, "job", "JB");
      const now = new Date();
      await c.query(
        `INSERT INTO jobs (id, number, bike_id, client_id, kind, priority, status, title, description, source, off_road, off_road_since, scheduled_for, assigned_to, reported_by, checklist)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          id,
          number,
          input.bikeId,
          bike.client_id,
          input.kind,
          input.priority,
          input.scheduledFor ? "scheduled" : "open",
          input.title,
          input.description,
          source,
          input.offRoad,
          input.offRoad ? now : null,
          input.scheduledFor,
          input.assignedTo,
          uid(req),
          JSON.stringify(checklistFor(input.kind, settings)),
        ],
      );
      if (input.offRoad) await syncDowntime(c, id, input.bikeId, true, now);
      await audit(c, { userId: uid(req), action: source === "client" ? "job.defect_reported" : "job.create", entity: "job", entityId: id, details: { number, plate: bike.plate, kind: input.kind }, ip: req.ip });
      return { id, number };
    });
  }

  app.post("/jobs", { preHandler: managers }, async (req, reply) => {
    const j = parse(jobCreateSchema, req.body);
    await assertAssignable(j.assignedTo);
    return reply.status(201).send(await createJob(req, j, "workshop"));
  });

  /** Fleet clients (and staff taking a phone call) report a problem with a bike. */
  app.post("/defects", { preHandler: anyone, config: { rateLimit: { max: 30, timeWindow: "1 hour" } } }, async (req, reply) => {
    const d = parse(defectReportSchema, req.body);
    const u = req.session!.user;
    const created = await createJob(
      req,
      { bikeId: d.bikeId, kind: "defect", priority: d.offRoad ? "urgent" : "normal", title: d.title, description: d.description, offRoad: d.offRoad, scheduledFor: null, assignedTo: null },
      u.role === "client" ? "client" : "workshop",
    );
    return reply.status(201).send(created);
  });

  app.put<{ Params: { id: string } }>("/jobs/:id", { preHandler: managers }, async (req) => {
    const j = parse(jobUpdateSchema, req.body);
    await assertAssignable(j.assignedTo);
    await tx(app.db, async (c) => {
      const job = await lockJob(c, req.params.id);
      assertEditable(job);
      if (job.version !== j.version) throw conflict("Someone else changed this job. Reload to see their changes.");
      const now = new Date();
      await c.query(
        `UPDATE jobs SET priority = $2, title = $3, description = $4, off_road = $5,
                off_road_since = CASE WHEN $5 THEN COALESCE(off_road_since, $8) ELSE NULL END,
                scheduled_for = $6, assigned_to = $7,
                status = CASE WHEN status IN ('open', 'scheduled') THEN (CASE WHEN $6::date IS NULL THEN 'open' ELSE 'scheduled' END) ELSE status END,
                version = version + 1, updated_at = now()
          WHERE id = $1`,
        [job.id, j.priority, j.title, j.description, j.offRoad, j.scheduledFor, j.assignedTo, now],
      );
      if (j.offRoad !== job.off_road) await syncDowntime(c, job.id, job.bike_id, j.offRoad, now);
      await audit(c, { userId: uid(req), action: "job.update", entity: "job", entityId: job.id, details: j, ip: req.ip });
    });
    return detail(req, req.params.id);
  });

  // ---- work on a job (managers here; technicians usually go through /tech/sync, which uses the same rules) ----

  const withJob = async (req: FastifyRequest<{ Params: { id: string } }>, fn: (c: Parameters<Parameters<typeof tx>[1]>[0], job: Awaited<ReturnType<typeof lockJob>>) => Promise<unknown>) => {
    await tx(app.db, async (c) => fn(c, await lockJob(c, req.params.id)));
    return detail(req, req.params.id);
  };

  app.post<{ Params: { id: string } }>("/jobs/:id/checklist", { preHandler: staff }, async (req) => {
    const b = parse(checkSchema, req.body);
    return withJob(req, (c, job) => setCheck(c, job, b.key, b.result, b.note));
  });

  app.post<{ Params: { id: string } }>("/jobs/:id/parts", { preHandler: staff }, async (req) => {
    const b = parse(partAddSchema, req.body);
    return withJob(req, (c, job) => addPart(c, job, req.session!.user, b.partId, b.qty));
  });

  app.delete<{ Params: { id: string; partLine: string } }>("/jobs/:id/parts/:partLine", { preHandler: staff }, async (req) =>
    withJob(req, (c, job) => removePart(c, job, req.session!.user, req.params.partLine)),
  );

  app.post<{ Params: { id: string } }>("/jobs/:id/notes", { preHandler: staff }, async (req) => {
    const b = parse(noteSchema, req.body);
    return withJob(req, (c, job) => addNote(c, job, req.session!.user, b.text, new Date()));
  });

  app.post<{ Params: { id: string } }>("/jobs/:id/timer", { preHandler: staff }, async (req) => {
    const { action } = parse(z.object({ action: z.enum(["start", "stop"]) }), req.body);
    return withJob(req, (c, job) => (action === "start" ? startTimer(c, job, req.session!.user, new Date()) : stopTimer(c, job, req.session!.user, new Date())));
  });

  app.post<{ Params: { id: string } }>("/jobs/:id/waiting-parts", { preHandler: staff }, async (req) => withJob(req, (c, job) => setWaitingParts(c, job, new Date())));

  app.post<{ Params: { id: string } }>("/jobs/:id/complete", { preHandler: staff }, async (req) => {
    const b = parse(completeSchema, req.body);
    let followUp: string | null = null;
    const job = await withJob(req, async (c, j) => {
      followUp = await completeJob(c, j, req.session!.user, b, new Date(), todayIn(app.config.TIMEZONE));
    });
    return { ...job, followUpId: followUp };
  });

  app.post<{ Params: { id: string } }>("/jobs/:id/cancel", { preHandler: managers }, async (req) => {
    const { reason } = parse(cancelSchema, req.body);
    return withJob(req, async (c, job) => {
      assertEditable(job);
      const parts = await c.query("SELECT 1 FROM job_parts WHERE job_id = $1 LIMIT 1", [job.id]);
      if (parts.rowCount) throw conflict("Take the parts off the job first, so they go back into stock.");
      const now = new Date();
      await c.query("UPDATE job_labour SET ended_at = GREATEST($2, started_at + interval '1 minute') WHERE job_id = $1 AND ended_at IS NULL", [job.id, now]);
      await c.query("UPDATE jobs SET status = 'cancelled', off_road = false, off_road_since = NULL, version = version + 1, updated_at = now() WHERE id = $1", [job.id]);
      await syncDowntime(c, job.id, job.bike_id, false, now);
      await addNote(c, job, req.session!.user, `Cancelled: ${reason}`, now);
      await audit(c, { userId: uid(req), action: "job.cancel", entity: "job", entityId: job.id, details: { reason }, ip: req.ip });
    });
  });

  // Labour times can be corrected until the job is invoiced.
  const assertLabourEditable = (job: { status: string; invoice_id: string | null; number: string }) => {
    if (job.invoice_id) throw new HttpError(409, `${job.number} has been invoiced; its times can't change.`, "invoiced");
    if (job.status === "cancelled") throw new HttpError(409, `${job.number} is cancelled.`, "job_closed");
  };

  app.put<{ Params: { id: string; entry: string } }>("/jobs/:id/labour/:entry", { preHandler: managers }, async (req) => {
    const l = parse(labourEditSchema, req.body);
    return withJob(req, async (c, job) => {
      assertLabourEditable(job);
      const { rows } = await c.query<{ technician_id: string; started_at: Date; ended_at: Date | null }>(
        "SELECT technician_id, started_at, ended_at FROM job_labour WHERE id = $1 AND job_id = $2 FOR UPDATE",
        [req.params.entry, job.id],
      );
      const entry = rows[0];
      if (!entry) throw notFound("Time entry not found");
      if (!entry.ended_at) throw conflict("Stop the clock before correcting this entry.");
      const overlap = await c.query(
        `SELECT 1 FROM job_labour WHERE technician_id = $1 AND id <> $2 AND started_at < $4 AND COALESCE(ended_at, now()) > $3 LIMIT 1`,
        [entry.technician_id, req.params.entry, l.startedAt, l.endedAt],
      );
      if (overlap.rowCount) throw badRequest("That overlaps another time entry for the same technician.", { startedAt: "Overlaps" });
      await c.query("UPDATE job_labour SET started_at = $2, ended_at = $3 WHERE id = $1", [req.params.entry, l.startedAt, l.endedAt]);
      await audit(c, {
        userId: uid(req),
        action: "labour.update",
        entity: "job",
        entityId: job.id,
        details: { entry: req.params.entry, from: { startedAt: entry.started_at, endedAt: entry.ended_at }, to: l },
        ip: req.ip,
      });
    });
  });

  app.delete<{ Params: { id: string; entry: string } }>("/jobs/:id/labour/:entry", { preHandler: managers }, async (req) =>
    withJob(req, async (c, job) => {
      assertLabourEditable(job);
      const r = await c.query("DELETE FROM job_labour WHERE id = $1 AND job_id = $2 RETURNING started_at, ended_at", [req.params.entry, job.id]);
      if (!r.rowCount) throw notFound("Time entry not found");
      await audit(c, { userId: uid(req), action: "labour.delete", entity: "job", entityId: job.id, details: { entry: req.params.entry, ...r.rows[0] }, ip: req.ip });
    }),
  );

  // ---- photos ----

  app.post<{ Params: { id: string } }>("/jobs/:id/photos", { preHandler: staff, bodyLimit: MAX_PHOTO_BYTES + 64 * 1024 }, async (req, reply) => {
    let file: { filename: string; data: Buffer } | null = null;
    for await (const part of req.parts({ limits: { fileSize: MAX_PHOTO_BYTES, files: 1, fields: 2 } })) {
      if (part.type === "file") {
        const data = await part.toBuffer();
        if (part.file.truncated) throw new HttpError(413, "Photos can be at most 5 MB.", "too_large");
        file = { filename: part.filename, data };
      }
    }
    if (!file || !file.data.length) throw badRequest("Choose a photo.", { file: "Required" });
    const mime = sniffImage(file.data);
    if (!mime) throw badRequest("Upload a JPEG, PNG or WebP photo.", { file: "Unsupported file type" });
    const base = file.filename.replace(/\.[^.]*$/, "").replace(/[^\w\- ]+/g, "_").trim().slice(0, 80) || "photo";
    const id = newId("ph");
    await tx(app.db, async (c) => {
      const job = await lockJob(c, req.params.id);
      if (job.invoice_id) throw new HttpError(409, `${job.number} has been invoiced.`, "invoiced");
      const count = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM job_photos WHERE job_id = $1", [job.id]);
      if (count.rows[0].n >= 30) throw badRequest("A job can have at most 30 photos.");
      await c.query("INSERT INTO job_photos (id, job_id, name, mime, size, bytes, added_by) VALUES ($1, $2, $3, $4, $5, $6, $7)", [
        id,
        job.id,
        `${base}.${EXT[mime]}`,
        mime,
        file!.data.length,
        file!.data,
        uid(req),
      ]);
    });
    return reply.status(201).send({ id });
  });

  app.get<{ Params: { id: string } }>("/photos/:id", { preHandler: anyone }, async (req, reply) => {
    const { rows } = await app.db.query<{ mime: string; name: string; bytes: Buffer; client_id: string }>(
      "SELECT p.mime, p.name, p.bytes, j.client_id FROM job_photos p JOIN jobs j ON j.id = p.job_id WHERE p.id = $1",
      [req.params.id],
    );
    if (!rows[0]) throw notFound("Photo not found");
    assertCanSee(req.session!.user, rows[0].client_id);
    return reply
      .header("content-type", rows[0].mime)
      .header("content-disposition", `inline; filename="${rows[0].name}"`)
      .header("x-content-type-options", "nosniff")
      .header("cache-control", "private, max-age=3600")
      .send(rows[0].bytes);
  });

  app.delete<{ Params: { id: string } }>("/photos/:id", { preHandler: managers }, async (req) => {
    const r = await app.db.query("DELETE FROM job_photos WHERE id = $1 RETURNING job_id", [req.params.id]);
    if (!r.rowCount) throw notFound("Photo not found");
    await audit(app.db, { userId: uid(req), action: "photo.delete", entity: "job", entityId: r.rows[0].job_id, details: { photo: req.params.id }, ip: req.ip });
    return { ok: true };
  });
}
