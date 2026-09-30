// Demo data: three delivery fleets, their bikes, workshop staff, parts, 90 days of history, open work and invoices.
import type { Queryable } from "./db";
import { todayIn } from "./config";
import { addDays, DEFAULT_SETTINGS, invoiceLines, invoiceTotals, newChecklist, type InvoiceJob } from "../../shared/fleet";
import { hashPassword } from "./security/password";
import { nextNumber, saveSettings } from "./repo/data";

const CLIENTS = [
  { id: "c-quickbite", name: "QuickBite Deliveries", contact: "Priya Shah", email: "fleet@quickbite.example", phone: "020 7946 0101", rate: null, bikes: 16 },
  { id: "c-metro", name: "Metro Courier Co", contact: "Tom Reilly", email: "ops@metrocourier.example", phone: "020 7946 0202", rate: 5500, bikes: 11 },
  { id: "c-pharma", name: "City Pharmacy Runs", contact: "Dr Ana Costa", email: "admin@cityph.example", phone: "020 7946 0303", rate: null, bikes: 6 },
];
const MODELS = [
  { make: "Honda", model: "PCX125", cc: 125, km: 4000, days: 180 },
  { make: "Yamaha", model: "NMAX 125", cc: 125, km: 4000, days: 180 },
  { make: "Honda", model: "SH125i", cc: 125, km: 5000, days: 180 },
  { make: "Super Soco", model: "CPx", cc: 0, km: 6000, days: 365 },
];
const PARTS = [
  ["OIL-10W40", "Engine oil 10W-40", "litre", 40, 8, 450, 900],
  ["FLT-OIL-PCX", "Oil filter PCX/SH", "each", 30, 6, 350, 850],
  ["PAD-F-125", "Front brake pads 125cc", "each", 24, 6, 900, 2200],
  ["PAD-R-125", "Rear brake pads 125cc", "each", 20, 6, 850, 2000],
  ["TYR-F-110", "Front tyre 110/70-14", "each", 10, 4, 3200, 5900],
  ["TYR-R-130", "Rear tyre 130/70-13", "each", 10, 4, 3600, 6500],
  ["BLB-H4", "Headlight bulb H4", "each", 15, 5, 300, 900],
  ["BLB-IND", "Indicator bulb", "each", 30, 10, 60, 250],
  ["BLT-CVT", "CVT drive belt", "each", 6, 3, 2400, 4800],
  ["PLG-SPK", "Spark plug", "each", 25, 8, 280, 750],
  ["FLD-DOT4", "Brake fluid DOT 4", "litre", 5, 2, 600, 1400],
  ["CBL-THR", "Throttle cable", "each", 2, 3, 700, 1800],
  ["MIR-L", "Mirror left", "each", 8, 3, 800, 1900],
  ["BAT-12V", "Battery 12V 7Ah", "each", 5, 2, 2100, 4200],
] as const;
const DEFECTS = [
  ["Front brake spongy", "Rider says front brake lever comes back to the bar.", true],
  ["Rear tyre flat", "Puncture on the ring road, recovered by van.", true],
  ["Indicator not working", "Left rear indicator out.", false],
  ["Engine warning light", "Light on since this morning, runs OK.", false],
  ["Chain noise", "Rattle from chain at low speed.", false],
  ["Won't start", "Clicks but won't turn over.", true],
] as const;

/** Small deterministic generator so every seeded database looks the same. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export async function seedDemo(c: Queryable, opts: { now: Date; timeZone: string; force: boolean; password: string }) {
  const existing = await c.query("SELECT 1 FROM bikes LIMIT 1");
  if (existing.rowCount && !opts.force) throw new Error("The database already has bikes. Run with --force to replace all business data.");
  await c.query(
    `TRUNCATE processed_ops, invoice_lines, job_photos, job_notes, stock_moves, job_parts, job_labour, bike_downtime, jobs, invoices,
              parts, bikes, sessions, users, clients, counters, settings, audit_log RESTART IDENTITY CASCADE`,
  );
  const r = rng(42);
  const pick = <T,>(a: readonly T[]) => a[Math.floor(r() * a.length)];
  const today = todayIn(opts.timeZone, opts.now);
  const settings = { ...DEFAULT_SETTINGS, companyName: "Two Wheel Fleet Care", companyAddress: "Unit 4, Canal Yard, London E3 2AB" };
  await saveSettings(c, settings);

  for (const cl of CLIENTS) {
    await c.query("INSERT INTO clients (id, name, contact_name, email, phone, address, labour_rate_cents) VALUES ($1, $2, $3, $4, $5, $6, $7)", [
      cl.id, cl.name, cl.contact, cl.email, cl.phone, "London", cl.rate,
    ]);
  }
  const hash = await hashPassword(opts.password);
  const users = [
    ["u-admin", "admin@demo.local", "Alex Morgan", "admin", null],
    ["u-manager", "manager@demo.local", "Sam Patel", "manager", null],
    ["u-tech1", "tech@demo.local", "Jordan Lee", "technician", null],
    ["u-tech2", "tech2@demo.local", "Casey Brown", "technician", null],
    ["u-tech3", "tech3@demo.local", "Riley Evans", "technician", null],
    ["u-client", "client@demo.local", "Priya Shah", "client", "c-quickbite"],
    ["u-client2", "client2@demo.local", "Tom Reilly", "client", "c-metro"],
  ] as const;
  for (const [id, email, name, role, clientId] of users) {
    await c.query("INSERT INTO users (id, email, name, role, client_id, password_hash) VALUES ($1, $2, $3, $4, $5, $6)", [id, email, name, role, clientId, hash]);
  }
  const techs = ["u-tech1", "u-tech2", "u-tech3"];

  for (const [sku, name, unit, stock, min, cost, price] of PARTS) {
    await c.query("INSERT INTO parts (id, sku, name, unit, stock_qty, min_qty, cost_cents, price_cents) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", [
      `p-${sku.toLowerCase()}`, sku, name, unit, stock, min, cost, price,
    ]);
    await c.query("INSERT INTO stock_moves (part_id, qty, reason, note, at) VALUES ($1, $2, 'delivery', 'Opening stock', $3)", [`p-${sku.toLowerCase()}`, stock, new Date(opts.now.getTime() - 100 * 86_400_000)]);
  }
  const partList = PARTS.map(([sku, , , , , cost, price]) => ({ id: `p-${sku.toLowerCase()}`, sku, cost, price }));

  // Bikes: odometer and last service spread so some are due, some overdue.
  const bikes: { id: string; client: string; plate: string; odo: number; interval: number; lastKm: number }[] = [];
  let n = 0;
  for (const cl of CLIENTS) {
    for (let i = 0; i < cl.bikes; i++) {
      n++;
      const m = MODELS[(n + i) % MODELS.length];
      const plate = `LK${20 + (n % 6)}${String.fromCharCode(65 + (n % 26))}${String.fromCharCode(66 + ((n * 7) % 24))}${String.fromCharCode(67 + ((n * 3) % 23))}`;
      const odo = 6000 + Math.floor(r() * 30000);
      const sinceKm = Math.floor(r() * m.km * 1.15);
      const lastDate = addDays(today, -Math.floor(r() * m.days * 1.05));
      const id = `bk-${n}`;
      bikes.push({ id, client: cl.id, plate, odo, interval: m.km, lastKm: odo - sinceKm });
      await c.query(
        `INSERT INTO bikes (id, client_id, plate, vin, make, model, year, engine_cc, odometer_km, service_interval_km, service_interval_days, last_service_km, last_service_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [id, cl.id, plate, `VIN${String(100000 + n * 7919).slice(-6)}DEMO${n}`, m.make, m.model, 2021 + (n % 4), m.cc, odo, m.km, m.days, odo - sinceKm, lastDate],
      );
    }
  }

  const day = 86_400_000;
  const at = (daysAgo: number, hour: number, min = 0) => {
    const d = new Date(opts.now.getTime() - daysAgo * day);
    d.setUTCHours(hour, min, 0, 0);
    return d;
  };

  async function job(o: {
    bike: (typeof bikes)[number];
    kind: string;
    title: string;
    description?: string;
    status: string;
    created: Date;
    offRoad?: boolean;
    tech?: string | null;
    source?: string;
    priority?: string;
  }) {
    const id = `j-${await nextNumber(c, "job-id", "x")}`;
    const number = await nextNumber(c, "job", "JB");
    const list = o.kind === "service" ? newChecklist(settings.serviceChecklist) : o.kind === "inspection" ? newChecklist(settings.inspectionChecklist) : [];
    await c.query(
      `INSERT INTO jobs (id, number, bike_id, client_id, kind, priority, status, title, description, source, off_road, off_road_since, assigned_to, reported_by, checklist, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8, $9, $10, $11, $12, 'u-manager', $13, $14, $14)`,
      [id, number, o.bike.id, o.bike.client, o.kind, o.priority ?? (o.offRoad ? "urgent" : "normal"), o.title, o.description ?? "", o.source ?? "workshop", !!o.offRoad, o.offRoad ? o.created : null, o.tech ?? null, JSON.stringify(list), o.created],
    );
    if (o.offRoad) await c.query("INSERT INTO bike_downtime (bike_id, job_id, started_at) VALUES ($1, $2, $3)", [o.bike.id, id, o.created]);
    return { id, number, list };
  }

  async function work(jobId: string, tech: string, start: Date, minutes: number, running = false) {
    const end = new Date(start.getTime() + minutes * 60_000);
    await c.query("INSERT INTO job_labour (id, job_id, technician_id, started_at, ended_at) VALUES ($1, $2, $3, $4, $5)", [`l-${jobId}-${start.getTime()}`, jobId, tech, start, running ? null : end]);
    return end;
  }

  async function usePart(jobId: string, tech: string, part: (typeof partList)[number], qty: number, when: Date) {
    // The history uses more than the opening stock, as a real workshop would: book a delivery when it runs short.
    const left = (await c.query<{ q: number }>("SELECT stock_qty::float AS q FROM parts WHERE id = $1", [part.id])).rows[0].q;
    if (left < qty + 2) {
      await c.query("UPDATE parts SET stock_qty = stock_qty + 20 WHERE id = $1", [part.id]);
      await c.query("INSERT INTO stock_moves (part_id, qty, reason, note, at) VALUES ($1, 20, 'delivery', 'Supplier delivery', $2)", [part.id, new Date(when.getTime() - 3600_000)]);
    }
    await c.query("INSERT INTO job_parts (id, job_id, part_id, qty, unit_cost_cents, unit_price_cents, added_by, added_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", [
      `jp-${jobId}-${part.sku}`, jobId, part.id, qty, part.cost, part.price, tech, when,
    ]);
    await c.query("UPDATE parts SET stock_qty = stock_qty - $2 WHERE id = $1", [part.id, qty]);
    await c.query("INSERT INTO stock_moves (part_id, qty, reason, job_id, user_id, at) VALUES ($1, $2, 'job', $3, $4, $5)", [part.id, -qty, jobId, tech, when]);
  }

  // ---- 90 days of finished work ----
  let done = 0;
  for (let d = 90; d >= 1; d--) {
    const count = [0, 6].includes(at(d, 12).getUTCDay()) ? 1 : 3;
    for (let k = 0; k < count; k++) {
      const bike = pick(bikes);
      const tech = pick(techs);
      const service = r() < 0.5;
      const defect = service ? null : pick(DEFECTS);
      const created = at(d, 8, Math.floor(r() * 50));
      const j = await job({
        bike, kind: service ? "service" : "defect", title: service ? "Scheduled service" : defect![0], description: defect?.[1] ?? "", status: "done", created, offRoad: defect?.[2] ?? false, tech,
        source: service ? "workshop" : r() < 0.5 ? "client" : "workshop",
      });
      const started = at(d, 9 + k * 2, Math.floor(r() * 30));
      const end = await work(j.id, tech, started, 35 + Math.floor(r() * 80));
      if (service) {
        await usePart(j.id, tech, partList[0], 1, started);
        await usePart(j.id, tech, partList[1], 1, started);
        if (r() < 0.3) await usePart(j.id, tech, partList[2], 1, started);
      } else {
        await usePart(j.id, tech, pick(partList.slice(2, 10)), 1, started);
      }
      for (const item of j.list) item.result = item.key === "suspension" && r() < 0.1 ? "na" : "pass";
      const odo = Math.max(0, bike.odo - d * 40);
      await c.query(
        `UPDATE jobs SET status = 'done', started_at = $2, completed_at = $3, odometer_km = $4, summary = $5, checklist = $6, updated_at = $3 WHERE id = $1`,
        [j.id, started, end, odo, service ? "Serviced to schedule. No advisories." : "Fixed and road tested.", JSON.stringify(j.list)],
      );
      await c.query("UPDATE bike_downtime SET ended_at = $2 WHERE job_id = $1 AND ended_at IS NULL", [j.id, end]);
      done++;
    }
  }

  // A bike's last service is its latest finished service job, where it has one in the history.
  await c.query(
    `UPDATE bikes b SET last_service_km = s.odometer_km, last_service_date = (s.completed_at AT TIME ZONE $1)::date
       FROM (SELECT DISTINCT ON (bike_id) bike_id, odometer_km, completed_at FROM jobs WHERE kind = 'service' AND status = 'done'
              ORDER BY bike_id, completed_at DESC) s
      WHERE s.bike_id = b.id`,
    [opts.timeZone],
  );

  // ---- invoice last month's work for each client ----
  const now = new Date(`${today}T00:00:00Z`);
  const firstThis = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const firstLast = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const lastDay = new Date(firstThis.getTime() - day);
  const pStart = firstLast.toISOString().slice(0, 10);
  const pEnd = lastDay.toISOString().slice(0, 10);
  let invoices = 0;
  for (const cl of CLIENTS) {
    const jobs = await c.query<{ id: string; number: string; plate: string; title: string }>(
      `SELECT j.id, j.number, b.plate, j.title FROM jobs j JOIN bikes b ON b.id = j.bike_id
        WHERE j.client_id = $1 AND j.status = 'done' AND (j.completed_at AT TIME ZONE $4)::date BETWEEN $2 AND $3 ORDER BY j.completed_at`,
      [cl.id, pStart, pEnd, opts.timeZone],
    );
    if (!jobs.rows.length) continue;
    const ij: InvoiceJob[] = [];
    for (const j of jobs.rows) {
      const m = await c.query<{ m: number }>("SELECT COALESCE(sum(round(extract(epoch FROM ended_at - started_at) / 60)), 0)::int AS m FROM job_labour WHERE job_id = $1", [j.id]);
      const ps = await c.query<{ name: string; qty: number; price: number }>(
        "SELECT p.sku || ' ' || p.name AS name, jp.qty::float AS qty, jp.unit_price_cents AS price FROM job_parts jp JOIN parts p ON p.id = jp.part_id WHERE jp.job_id = $1 ORDER BY jp.added_at",
        [j.id],
      );
      ij.push({ jobId: j.id, number: j.number, plate: j.plate, title: j.title, minutes: m.rows[0].m, parts: ps.rows.map((p) => ({ name: p.name, qty: p.qty, unitPriceCents: p.price })) });
    }
    const lines = invoiceLines(ij, cl.rate ?? settings.labourRateCents, settings.labourBlockMinutes);
    const t = invoiceTotals(lines, settings.taxPercent);
    const id = `inv-${cl.id}`;
    const number = await nextNumber(c, "invoice", "INV");
    await c.query(
      `INSERT INTO invoices (id, number, client_id, period_start, period_end, issued_at, due_date, tax_percent, subtotal_cents, tax_cents, total_cents, status, issued_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'u-manager')`,
      [id, number, cl.id, pStart, pEnd, firstThis, addDays(pEnd, 1 + settings.paymentTermsDays), settings.taxPercent, t.subtotalCents, t.taxCents, t.totalCents, cl.id === "c-pharma" ? "paid" : "issued"],
    );
    for (const l of lines) {
      await c.query("INSERT INTO invoice_lines (invoice_id, job_id, description, qty, unit_cents, amount_cents, is_labour) VALUES ($1, $2, $3, $4, $5, $6, $7)", [id, l.jobId, l.description, l.qty, l.unitCents, l.amountCents, l.isLabour]);
    }
    await c.query("UPDATE jobs SET invoice_id = $1 WHERE id = ANY($2)", [id, jobs.rows.map((j) => j.id)]);
    invoices++;
  }

  // ---- open work today ----
  const open = bikes.slice(0, 9);
  const d0 = await job({ bike: open[0], kind: "defect", title: "Front brake spongy", description: "Rider reports the lever comes back to the bar.", status: "open", created: at(0, 7, 40), offRoad: true, source: "client" });
  void d0;
  const d1 = await job({ bike: open[1], kind: "service", title: "Scheduled service", status: "in_progress", created: at(1, 16), tech: "u-tech1" });
  await c.query("UPDATE jobs SET status = 'in_progress', started_at = $2 WHERE id = $1", [d1.id, at(0, 8, 5)]);
  await work(d1.id, "u-tech1", new Date(opts.now.getTime() - 40 * 60_000), 0, true);
  d1.list.slice(0, 5).forEach((i) => (i.result = "pass"));
  await c.query("UPDATE jobs SET checklist = $2 WHERE id = $1", [d1.id, JSON.stringify(d1.list)]);
  await usePart(d1.id, "u-tech1", partList[0], 1, at(0, 8, 20));
  const d2 = await job({ bike: open[2], kind: "repair", title: "Replace CVT belt", description: "Belt slipping under load.", status: "waiting_parts", created: at(3, 9), tech: "u-tech2", offRoad: true });
  await work(d2.id, "u-tech2", at(3, 10), 45);
  await c.query("UPDATE jobs SET status = 'waiting_parts', started_at = $2 WHERE id = $1", [d2.id, at(3, 10)]);
  await c.query("INSERT INTO job_notes (id, job_id, user_id, text, at) VALUES ('n-d2', $1, 'u-tech2', 'Belt worn past limit. Ordered CVT belt from supplier, due Thursday.', $2)", [d2.id, at(3, 11)]);
  for (const [i, b] of open.slice(3, 6).entries()) {
    const s = await job({ bike: b, kind: "service", title: "Scheduled service", status: "scheduled", created: at(2, 9), tech: techs[i % 3] });
    await c.query("UPDATE jobs SET status = 'scheduled', scheduled_for = $2 WHERE id = $1", [s.id, addDays(today, i)]);
  }
  await job({ bike: open[6], kind: "inspection", title: "Monthly safety inspection", status: "open", created: at(0, 8) });
  await job({ bike: open[7], kind: "defect", title: "Indicator not working", description: "Left rear indicator out.", status: "open", created: at(1, 17), source: "client", tech: "u-tech3" });
  await job({ bike: open[8], kind: "defect", title: "Won't start", description: "Clicks but won't turn over. Bike at depot.", status: "open", created: at(0, 6, 55), offRoad: true, source: "client" });

  return `Demo data loaded: ${CLIENTS.length} clients, ${bikes.length} bikes, ${done} finished jobs, ${invoices} invoices, 9 open jobs. Log in as admin@demo.local, manager@demo.local, tech@demo.local or client@demo.local with the demo password.`;
}
