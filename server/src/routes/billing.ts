import type { FastifyInstance, FastifyRequest } from "fastify";
import { tx, type Queryable } from "../db";
import { badRequest, conflict, HttpError, notFound, parse, requireUser } from "../http";
import { addDays, invoiceLines, invoiceTotals, type InvoiceJob } from "../../../shared/fleet";
import { assertCanSee, audit, getSettings, newId, nextNumber, seesCost } from "../repo/data";
import { invoiceRunSchema, partSchema, stockMoveSchema } from "../../../shared/schemas";
import type { InvoiceDetail, InvoiceSummary, Part } from "../../../shared/types";

export async function billingRoutes(app: FastifyInstance) {
  const anyone = requireUser();
  const staff = requireUser("admin", "manager", "technician");
  const managers = requireUser("admin", "manager");
  const uid = (req: FastifyRequest) => req.session!.user.id;

  // ---- parts ----

  app.get<{ Querystring: { q?: string; low?: string; all?: string } }>("/parts", { preHandler: staff }, async (req) => {
    const q = (req.query.q ?? "").trim().toLowerCase().replace(/[%_\\]/g, "").slice(0, 60);
    const { rows } = await app.db.query(
      `SELECT * FROM parts
        WHERE ($1 = '' OR lower(sku) LIKE '%' || $1 || '%' OR lower(name) LIKE '%' || $1 || '%')
          AND ($2 OR stock_qty <= min_qty) AND ($3 OR active)
        ORDER BY name LIMIT 500`,
      [q, req.query.low !== "1", req.query.all === "1"],
    );
    const cost = seesCost(req.session!.user.role);
    return {
      items: rows.map(
        (p): Part => ({
          id: p.id,
          sku: p.sku,
          name: p.name,
          unit: p.unit,
          stockQty: p.stock_qty,
          minQty: p.min_qty,
          priceCents: p.price_cents,
          ...(cost ? { costCents: p.cost_cents } : {}),
          active: p.active,
        }),
      ),
    };
  });

  app.post("/parts", { preHandler: managers }, async (req, reply) => {
    const p = parse(partSchema, req.body);
    const id = newId("p");
    try {
      await app.db.query("INSERT INTO parts (id, sku, name, unit, min_qty, cost_cents, price_cents, active) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", [
        id,
        p.sku,
        p.name,
        p.unit,
        p.minQty,
        p.costCents,
        p.priceCents,
        p.active,
      ]);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new HttpError(409, "That part number is already in the catalogue.", "conflict", { sku: "Already used" });
      throw e;
    }
    await audit(app.db, { userId: uid(req), action: "part.create", entity: "part", entityId: id, details: p, ip: req.ip });
    return reply.status(201).send({ id });
  });

  app.put<{ Params: { id: string } }>("/parts/:id", { preHandler: managers }, async (req) => {
    const p = parse(partSchema, req.body);
    try {
      const r = await app.db.query("UPDATE parts SET sku = $2, name = $3, unit = $4, min_qty = $5, cost_cents = $6, price_cents = $7, active = $8 WHERE id = $1", [
        req.params.id,
        p.sku,
        p.name,
        p.unit,
        p.minQty,
        p.costCents,
        p.priceCents,
        p.active,
      ]);
      if (!r.rowCount) throw notFound("Part not found");
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new HttpError(409, "That part number is already in the catalogue.", "conflict", { sku: "Already used" });
      throw e;
    }
    await audit(app.db, { userId: uid(req), action: "part.update", entity: "part", entityId: req.params.id, details: p, ip: req.ip });
    return { ok: true };
  });

  /** Deliveries, stock-take adjustments and returns to the supplier. */
  app.post<{ Params: { id: string } }>("/parts/:id/stock", { preHandler: managers }, async (req) => {
    const m = parse(stockMoveSchema, req.body);
    const qty = m.reason === "return" ? -Math.abs(m.qty) : m.reason === "delivery" ? Math.abs(m.qty) : m.qty;
    return tx(app.db, async (c) => {
      const { rows } = await c.query<{ stock_qty: number; sku: string; unit: string }>("SELECT stock_qty, sku, unit FROM parts WHERE id = $1 FOR UPDATE", [req.params.id]);
      if (!rows[0]) throw notFound("Part not found");
      if (rows[0].unit === "each" && !Number.isInteger(qty)) throw badRequest(`${rows[0].sku} is counted in whole units.`, { qty: "Whole number" });
      if (rows[0].stock_qty + qty < 0) throw badRequest(`That would take ${rows[0].sku} below zero (${rows[0].stock_qty} in stock).`, { qty: "Too many" });
      await c.query("UPDATE parts SET stock_qty = stock_qty + $2 WHERE id = $1", [req.params.id, qty]);
      await c.query("INSERT INTO stock_moves (part_id, qty, reason, user_id, note) VALUES ($1, $2, $3, $4, $5)", [req.params.id, qty, m.reason, uid(req), m.note]);
      await audit(c, { userId: uid(req), action: "part.stock", entity: "part", entityId: req.params.id, details: { qty, reason: m.reason, note: m.note }, ip: req.ip });
      return { stockQty: rows[0].stock_qty + qty };
    });
  });

  app.get<{ Params: { id: string } }>("/parts/:id/moves", { preHandler: managers }, async (req) => {
    const { rows } = await app.db.query(
      `SELECT m.id, m.at, m.qty, m.reason, m.note, u.name AS "userName", j.number AS "jobNumber", j.id AS "jobId"
         FROM stock_moves m LEFT JOIN users u ON u.id = m.user_id LEFT JOIN jobs j ON j.id = m.job_id
        WHERE m.part_id = $1 ORDER BY m.at DESC LIMIT 200`,
      [req.params.id],
    );
    return { items: rows.map((r) => ({ ...r, at: (r.at as Date).toISOString() })) };
  });

  // ---- invoices ----

  /** Finished, uninvoiced jobs for a client, completed within the period (dates in the garage's time zone). */
  async function billableJobs(c: Queryable, clientId: string, from: string, to: string, lock: boolean): Promise<InvoiceJob[]> {
    const jobs = await c.query<{ id: string; number: string; plate: string; title: string }>(
      `SELECT j.id, j.number, b.plate, j.title FROM jobs j JOIN bikes b ON b.id = j.bike_id
        WHERE j.client_id = $1 AND j.status = 'done' AND j.invoice_id IS NULL
          AND (j.completed_at AT TIME ZONE $4)::date BETWEEN $2 AND $3
        ORDER BY j.completed_at ${lock ? "FOR UPDATE OF j" : ""}`,
      [clientId, from, to, app.config.TIMEZONE],
    );
    if (!jobs.rows.length) return [];
    const ids = jobs.rows.map((j) => j.id);
    const [labour, parts] = await Promise.all([
      c.query<{ job_id: string; minutes: number }>(
        // Minutes per entry, rounded, then summed: the same figure the job page shows.
        `SELECT job_id, sum(round(extract(epoch FROM ended_at - started_at) / 60))::int AS minutes FROM job_labour
          WHERE job_id = ANY($1) AND ended_at IS NOT NULL GROUP BY job_id`,
        [ids],
      ),
      c.query<{ job_id: string; name: string; qty: number; unit_price_cents: number }>(
        `SELECT jp.job_id, p.sku || ' ' || p.name AS name, jp.qty, jp.unit_price_cents FROM job_parts jp JOIN parts p ON p.id = jp.part_id
          WHERE jp.job_id = ANY($1) ORDER BY jp.added_at`,
        [ids],
      ),
    ]);
    const mins = new Map(labour.rows.map((l) => [l.job_id, l.minutes]));
    return jobs.rows.map((j) => ({
      jobId: j.id,
      number: j.number,
      plate: j.plate,
      title: j.title,
      minutes: mins.get(j.id) ?? 0,
      parts: parts.rows.filter((p) => p.job_id === j.id).map((p) => ({ name: p.name, qty: p.qty, unitPriceCents: p.unit_price_cents })),
    }));
  }

  async function rateFor(c: Queryable, clientId: string, lock: boolean) {
    const { rows } = await c.query<{ labour_rate_cents: number | null; name: string }>(`SELECT labour_rate_cents, name FROM clients WHERE id = $1 ${lock ? "FOR UPDATE" : ""}`, [clientId]);
    if (!rows[0]) throw badRequest("That client doesn't exist.", { clientId: "Unknown client" });
    return rows[0];
  }

  app.post("/invoices/preview", { preHandler: managers }, async (req) => {
    const r = parse(invoiceRunSchema, req.body);
    const settings = await getSettings(app.db);
    const client = await rateFor(app.db, r.clientId, false);
    const jobs = await billableJobs(app.db, r.clientId, r.periodStart, r.periodEnd, false);
    const lines = invoiceLines(jobs, client.labour_rate_cents ?? settings.labourRateCents, settings.labourBlockMinutes);
    return { jobs: jobs.map((j) => ({ id: j.jobId, number: j.number, plate: j.plate, title: j.title, minutes: j.minutes })), lines, ...invoiceTotals(lines, settings.taxPercent) };
  });

  app.post("/invoices", { preHandler: managers }, async (req, reply) => {
    const r = parse(invoiceRunSchema, req.body);
    const settings = await getSettings(app.db);
    const out = await tx(app.db, async (c) => {
      // Locking the client serialises invoice runs for it, so two managers can't bill the same jobs twice.
      const client = await rateFor(c, r.clientId, true);
      const jobs = await billableJobs(c, r.clientId, r.periodStart, r.periodEnd, true);
      if (!jobs.length) throw badRequest(`No finished, uninvoiced jobs for ${client.name} in that period.`);
      const running = await c.query("SELECT 1 FROM job_labour WHERE job_id = ANY($1) AND ended_at IS NULL LIMIT 1", [jobs.map((j) => j.jobId)]);
      if (running.rowCount) throw conflict("A clock is still running on one of these jobs.");
      const lines = invoiceLines(jobs, client.labour_rate_cents ?? settings.labourRateCents, settings.labourBlockMinutes);
      const t = invoiceTotals(lines, settings.taxPercent);
      const id = newId("inv");
      const number = await nextNumber(c, "invoice", "INV");
      const issued = await c.query<{ today: string }>("SELECT (now() AT TIME ZONE $1)::date::text AS today", [app.config.TIMEZONE]);
      await c.query(
        `INSERT INTO invoices (id, number, client_id, period_start, period_end, due_date, tax_percent, subtotal_cents, tax_cents, total_cents, issued_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [id, number, r.clientId, r.periodStart, r.periodEnd, addDays(issued.rows[0].today, settings.paymentTermsDays), settings.taxPercent, t.subtotalCents, t.taxCents, t.totalCents, uid(req)],
      );
      for (const l of lines) {
        await c.query("INSERT INTO invoice_lines (invoice_id, job_id, description, qty, unit_cents, amount_cents, is_labour) VALUES ($1, $2, $3, $4, $5, $6, $7)", [
          id,
          l.jobId,
          l.description,
          l.qty,
          l.unitCents,
          l.amountCents,
          l.isLabour,
        ]);
      }
      await c.query("UPDATE jobs SET invoice_id = $1, version = version + 1 WHERE id = ANY($2)", [id, jobs.map((j) => j.jobId)]);
      await audit(c, { userId: uid(req), action: "invoice.issue", entity: "invoice", entityId: id, details: { number, totalCents: t.totalCents, jobs: jobs.length }, ip: req.ip });
      return { id, number };
    });
    return reply.status(201).send(out);
  });

  const INVOICES = `SELECT i.*, c.name AS client_name, c.address AS client_address FROM invoices i JOIN clients c ON c.id = i.client_id`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toInvoice = (r: any): InvoiceSummary => ({
    id: r.id,
    number: r.number,
    clientId: r.client_id,
    clientName: r.client_name,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    issuedAt: (r.issued_at as Date).toISOString(),
    dueDate: r.due_date,
    subtotalCents: r.subtotal_cents,
    taxCents: r.tax_cents,
    totalCents: r.total_cents,
    status: r.status,
  });

  app.get<{ Querystring: { clientId?: string } }>("/invoices", { preHandler: anyone }, async (req) => {
    const u = req.session!.user;
    if (u.role === "technician") throw new HttpError(403, "You don't have permission to do that.", "forbidden");
    const clientId = u.role === "client" ? u.clientId : req.query.clientId || null;
    const { rows } = await app.db.query(`${INVOICES} WHERE ($1::text IS NULL OR i.client_id = $1) ORDER BY i.issued_at DESC LIMIT 500`, [clientId]);
    return { items: rows.map(toInvoice) };
  });

  app.get<{ Params: { id: string } }>("/invoices/:id", { preHandler: anyone }, async (req): Promise<InvoiceDetail> => {
    const u = req.session!.user;
    if (u.role === "technician") throw new HttpError(403, "You don't have permission to do that.", "forbidden");
    const { rows } = await app.db.query(`${INVOICES} WHERE i.id = $1`, [req.params.id]);
    if (!rows[0]) throw notFound("Invoice not found");
    assertCanSee(u, rows[0].client_id);
    const lines = await app.db.query(
      `SELECT description, qty, unit_cents AS "unitCents", amount_cents AS "amountCents", is_labour AS "isLabour" FROM invoice_lines WHERE invoice_id = $1 ORDER BY id`,
      [req.params.id],
    );
    return { ...toInvoice(rows[0]), taxPercent: rows[0].tax_percent, clientAddress: rows[0].client_address, lines: lines.rows };
  });

  app.post<{ Params: { id: string } }>("/invoices/:id/paid", { preHandler: managers }, async (req) => {
    const r = await app.db.query("UPDATE invoices SET status = 'paid' WHERE id = $1 AND status = 'issued' RETURNING number", [req.params.id]);
    if (!r.rowCount) throw conflict("Only an issued invoice can be marked paid.");
    await audit(app.db, { userId: uid(req), action: "invoice.paid", entity: "invoice", entityId: req.params.id, ip: req.ip });
    return { ok: true };
  });

  /** Voiding keeps the number (no gaps) and frees the jobs to be invoiced again. */
  app.post<{ Params: { id: string } }>("/invoices/:id/void", { preHandler: managers }, async (req) => {
    await tx(app.db, async (c) => {
      const r = await c.query("UPDATE invoices SET status = 'void' WHERE id = $1 AND status = 'issued' RETURNING number", [req.params.id]);
      if (!r.rowCount) throw conflict("Only an issued, unpaid invoice can be voided.");
      await c.query("UPDATE jobs SET invoice_id = NULL, version = version + 1 WHERE invoice_id = $1", [req.params.id]);
      await audit(c, { userId: uid(req), action: "invoice.void", entity: "invoice", entityId: req.params.id, ip: req.ip });
    });
    return { ok: true };
  });
}
