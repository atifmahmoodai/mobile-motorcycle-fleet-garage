import type { FastifyInstance, FastifyRequest } from "fastify";
import { todayIn } from "../config";
import { tx } from "../db";
import { conflict, HttpError, notFound, parse, requireUser } from "../http";
import { assertCanSee, audit, BIKE_SELECT, getSettings, JOB_SELECT, newId, toBike, toJob } from "../repo/data";
import { bikeSchema, bikeUpdateSchema, clientSchema } from "../../../shared/schemas";
import type { Bike, Client } from "../../../shared/types";

const PLATE_TAKEN = "Another bike in service already has that registration.";

export async function fleetRoutes(app: FastifyInstance) {
  const anyone = requireUser();
  const staff = requireUser("admin", "manager", "technician");
  const managers = requireUser("admin", "manager");
  const uid = (req: FastifyRequest) => req.session!.user.id;

  // ---- clients ----

  const CLIENTS = `
    SELECT c.*, (SELECT count(*) FROM bikes b WHERE b.client_id = c.id AND NOT b.retired)::int AS bike_count,
           (SELECT count(*) FROM jobs j WHERE j.client_id = c.id AND j.status IN ('open', 'scheduled', 'in_progress', 'waiting_parts'))::int AS open_jobs
      FROM clients c`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toClient = (r: any): Client => ({
    id: r.id,
    name: r.name,
    contactName: r.contact_name,
    email: r.email,
    phone: r.phone,
    address: r.address,
    labourRateCents: r.labour_rate_cents,
    active: r.active,
    bikeCount: r.bike_count,
    openJobs: r.open_jobs,
  });

  app.get("/clients", { preHandler: staff }, async () => ({ items: (await app.db.query(`${CLIENTS} ORDER BY c.active DESC, c.name`)).rows.map(toClient) }));

  app.get<{ Params: { id: string } }>("/clients/:id", { preHandler: anyone }, async (req) => {
    assertCanSee(req.session!.user, req.params.id);
    const { rows } = await app.db.query(`${CLIENTS} WHERE c.id = $1`, [req.params.id]);
    if (!rows[0]) throw notFound("Client not found");
    const c = toClient(rows[0]);
    return req.session!.user.role === "client" ? { ...c, labourRateCents: null } : c;
  });

  app.post("/clients", { preHandler: managers }, async (req, reply) => {
    const c = parse(clientSchema, req.body);
    const id = newId("c");
    try {
      await app.db.query(
        "INSERT INTO clients (id, name, contact_name, email, phone, address, labour_rate_cents, active) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        [id, c.name, c.contactName, c.email, c.phone, c.address, c.labourRateCents, c.active],
      );
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new HttpError(409, "A client with that name already exists.", "conflict", { name: "Already exists" });
      throw e;
    }
    await audit(app.db, { userId: uid(req), action: "client.create", entity: "client", entityId: id, details: c, ip: req.ip });
    return reply.status(201).send({ id });
  });

  app.put<{ Params: { id: string } }>("/clients/:id", { preHandler: managers }, async (req) => {
    const c = parse(clientSchema, req.body);
    try {
      const r = await app.db.query(
        "UPDATE clients SET name = $2, contact_name = $3, email = $4, phone = $5, address = $6, labour_rate_cents = $7, active = $8 WHERE id = $1",
        [req.params.id, c.name, c.contactName, c.email, c.phone, c.address, c.labourRateCents, c.active],
      );
      if (!r.rowCount) throw notFound("Client not found");
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new HttpError(409, "A client with that name already exists.", "conflict", { name: "Already exists" });
      throw e;
    }
    await audit(app.db, { userId: uid(req), action: "client.update", entity: "client", entityId: req.params.id, details: c, ip: req.ip });
    return { ok: true };
  });

  // ---- bikes ----

  app.get<{ Querystring: { clientId?: string; q?: string; due?: string; retired?: string } }>("/bikes", { preHandler: anyone }, async (req) => {
    const u = req.session!.user;
    const clientId = u.role === "client" ? u.clientId : req.query.clientId || null;
    const q = (req.query.q ?? "").trim().toUpperCase().replace(/[^A-Z0-9 ]/g, "").slice(0, 40);
    const { rows } = await app.db.query(
      `${BIKE_SELECT}
        WHERE ($1::text IS NULL OR b.client_id = $1)
          AND ($2 = '' OR b.plate LIKE '%' || replace($2, ' ', '') || '%' OR upper(b.make || ' ' || b.model) LIKE '%' || $2 || '%')
          AND (b.retired = $3)
        ORDER BY b.plate`,
      [clientId, q, req.query.retired === "1"],
    );
    const [settings, today] = [await getSettings(app.db), todayIn(app.config.TIMEZONE)];
    let items: Bike[] = rows.map((r) => toBike(r, today, settings));
    if (req.query.due === "attention") items = items.filter((b) => b.due.status !== "ok" || b.offRoad);
    return { items };
  });

  app.get<{ Params: { id: string } }>("/bikes/:id", { preHandler: anyone }, async (req) => {
    const { rows } = await app.db.query(`${BIKE_SELECT} WHERE b.id = $1`, [req.params.id]);
    if (!rows[0]) throw notFound("Bike not found");
    assertCanSee(req.session!.user, rows[0].client_id);
    const bike = toBike(rows[0], todayIn(app.config.TIMEZONE), await getSettings(app.db));
    const jobs = await app.db.query(`${JOB_SELECT} WHERE j.bike_id = $1 ORDER BY j.created_at DESC LIMIT 100`, [req.params.id]);
    return { bike, jobs: jobs.rows.map(toJob) };
  });

  app.post("/bikes", { preHandler: managers }, async (req, reply) => {
    const b = parse(bikeSchema, req.body);
    const id = newId("bk");
    try {
      await app.db.query(
        `INSERT INTO bikes (id, client_id, plate, vin, make, model, year, engine_cc, odometer_km, service_interval_km, service_interval_days, last_service_km, last_service_date, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [id, b.clientId, b.plate, b.vin, b.make, b.model, b.year, b.engineCc, b.odometerKm, b.serviceIntervalKm, b.serviceIntervalDays, b.lastServiceKm, b.lastServiceDate, b.notes],
      );
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new HttpError(409, PLATE_TAKEN, "conflict", { plate: "Already in use" });
      throw e;
    }
    await audit(app.db, { userId: uid(req), action: "bike.create", entity: "bike", entityId: id, details: { plate: b.plate, clientId: b.clientId }, ip: req.ip });
    return reply.status(201).send({ id });
  });

  app.put<{ Params: { id: string } }>("/bikes/:id", { preHandler: managers }, async (req) => {
    const b = parse(bikeUpdateSchema, req.body);
    await tx(app.db, async (c) => {
      const { rows } = await c.query("SELECT version, odometer_km, client_id, plate FROM bikes WHERE id = $1 FOR UPDATE", [req.params.id]);
      const old = rows[0];
      if (!old) throw notFound("Bike not found");
      if (old.version !== b.version) throw conflict("Someone else changed this bike. Reload to see their changes.");
      if (b.retired || b.clientId !== old.client_id) {
        const open = await c.query("SELECT 1 FROM jobs WHERE bike_id = $1 AND status IN ('open', 'scheduled', 'in_progress', 'waiting_parts') LIMIT 1", [req.params.id]);
        if (open.rowCount) {
          throw conflict(`Finish or cancel the bike's open jobs before ${b.retired ? "retiring it" : "moving it to another client"}: they are billed to the current client.`);
        }
      }
      try {
        await c.query(
          `UPDATE bikes SET client_id = $2, plate = $3, vin = $4, make = $5, model = $6, year = $7, engine_cc = $8, odometer_km = $9,
                  service_interval_km = $10, service_interval_days = $11, last_service_km = $12, last_service_date = $13, notes = $14,
                  retired = $15, version = version + 1, updated_at = now()
            WHERE id = $1`,
          [req.params.id, b.clientId, b.plate, b.vin, b.make, b.model, b.year, b.engineCc, b.odometerKm, b.serviceIntervalKm, b.serviceIntervalDays, b.lastServiceKm, b.lastServiceDate, b.notes, b.retired],
        );
      } catch (e) {
        if ((e as { code?: string }).code === "23505") throw new HttpError(409, PLATE_TAKEN, "conflict", { plate: "Already in use" });
        throw e;
      }
      // Odometer corrections and moving a bike between clients are the edits people ask about later.
      const details: Record<string, unknown> = { plate: b.plate };
      if (old.odometer_km !== b.odometerKm) details.odometer = { from: old.odometer_km, to: b.odometerKm };
      if (old.client_id !== b.clientId) details.client = { from: old.client_id, to: b.clientId };
      if (b.retired) details.retired = true;
      await audit(c, { userId: uid(req), action: "bike.update", entity: "bike", entityId: req.params.id, details, ip: req.ip });
    });
    return { ok: true };
  });
}
