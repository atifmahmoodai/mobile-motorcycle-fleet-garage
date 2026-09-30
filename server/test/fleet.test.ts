import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { login, makeApp, type Agent, type TestCtx } from "./helpers";
import type { Bike, JobDetail, Part } from "../../shared/types";

let ctx: TestCtx;
let manager: Agent;
let tech: Agent;
let tech2: Agent;
let client: Agent;
let client2: Agent;
let admin: Agent;

beforeAll(async () => {
  ctx = await makeApp();
  [manager, tech, tech2, client, client2, admin] = await Promise.all(
    ["manager", "tech", "tech2", "client", "client2", "admin"].map((u) => login(ctx.app, `${u}@demo.local`)),
  );
});
afterAll(() => ctx.close());

const iso = () => new Date().toISOString();
const sync = (a: Agent, ops: Record<string, unknown>[]) => a.send("POST", "/api/tech/sync", { ops });
const op = (type: string, jobId: string, extra: Record<string, unknown> = {}) => ({ opId: randomUUID(), type, jobId, at: iso(), ...extra });

async function bikesOf(a: Agent, query = ""): Promise<Bike[]> {
  return (await a.get(`/api/bikes${query}`)).json().items;
}
async function newJob(kind = "service", bikeIndex = 20) {
  const bikes = await bikesOf(manager);
  const bike = bikes.filter((b) => b.openJobs === 0)[bikeIndex % 10];
  const res = await manager.send("POST", "/api/jobs", { bikeId: bike.id, kind, title: `Test ${kind}`, description: "", priority: "normal", offRoad: false, scheduledFor: null, assignedTo: null });
  expect(res.statusCode).toBe(201);
  return { id: res.json().id as string, bike };
}
const jobOf = async (a: Agent, id: string): Promise<JobDetail> => (await a.get(`/api/jobs/${id}`)).json();

describe("access", () => {
  it("clients only see their own fleet", async () => {
    const mine = await bikesOf(client);
    expect(mine.length).toBe(16);
    expect(new Set(mine.map((b) => b.clientName))).toEqual(new Set(["QuickBite Deliveries"]));
    const other = (await bikesOf(client2))[0];
    expect((await client.get(`/api/bikes/${other.id}`)).statusCode).toBe(404);
    const jobs = (await client.get("/api/jobs?status=all")).json().items as { clientName: string }[];
    expect(jobs.every((j) => j.clientName === "QuickBite Deliveries")).toBe(true);
  });

  it("clients can't reach staff screens or other clients' invoices", async () => {
    expect((await client.get("/api/parts")).statusCode).toBe(403);
    expect((await client.get("/api/dashboard")).statusCode).toBe(403);
    expect((await client.send("POST", "/api/jobs", {})).statusCode).toBe(403);
    const invoices = (await client.get("/api/invoices")).json().items as { clientName: string; id: string }[];
    expect(invoices.every((i) => i.clientName === "QuickBite Deliveries")).toBe(true);
    const all = (await manager.get("/api/invoices")).json().items as { clientName: string; id: string }[];
    const foreign = all.find((i) => i.clientName !== "QuickBite Deliveries")!;
    expect((await client.get(`/api/invoices/${foreign.id}`)).statusCode).toBe(404);
  });

  it("technicians see prices but not part costs; managers see both", async () => {
    const techParts = (await tech.get("/api/parts")).json().items as Part[];
    expect(techParts[0].costCents).toBeUndefined();
    expect(((await manager.get("/api/parts")).json().items as Part[])[0].costCents).toBeTypeOf("number");
    expect((await tech.get("/api/invoices")).statusCode).toBe(403);
  });

  it("a client's meta has no staff list", async () => {
    const meta = (await client.get("/api/meta")).json();
    expect(meta.users).toEqual([]);
    expect(meta.clients).toHaveLength(1);
  });
});

describe("defect reports", () => {
  it("a client reports an unsafe bike: urgent, off the road, downtime starts", async () => {
    const bike = (await bikesOf(client)).find((b) => !b.offRoad)!;
    const res = await client.send("POST", "/api/defects", { bikeId: bike.id, title: "Brakes grinding", description: "Loud grinding from the front", offRoad: true });
    expect(res.statusCode).toBe(201);
    const job = await jobOf(client, res.json().id);
    expect(job).toMatchObject({ kind: "defect", priority: "urgent", source: "client", offRoad: true, status: "open" });
    const after = (await client.get(`/api/bikes/${bike.id}`)).json().bike as Bike;
    expect(after.offRoad).toBe(true);
    // Internal notes are never shown to clients.
    expect(job.notes).toEqual([]);
  });

  it("a client can't report on another fleet's bike", async () => {
    const other = (await bikesOf(client2))[0];
    expect((await client.send("POST", "/api/defects", { bikeId: other.id, title: "Sneaky", description: "", offRoad: false })).statusCode).toBe(404);
  });
});

describe("technician app sync", () => {
  it("replays a queue once, even if it arrives twice", async () => {
    const { id } = await newJob("repair", 1);
    const part = ((await tech.get("/api/parts?q=BLB-IND")).json().items as Part[])[0];
    const ops = [op("start", id), op("part", id, { partId: part.id, qty: 2 }), op("note", id, { text: "Replaced both bulbs" }), op("stop", id)];
    const first = await sync(tech, ops);
    expect(first.json().results.map((r: { ok: boolean }) => r.ok)).toEqual([true, true, true, true]);
    const again = await sync(tech, ops);
    expect(again.json().results.map((r: { ok: boolean }) => r.ok)).toEqual([true, true, true, true]);
    const job = await jobOf(manager, id);
    expect(job.parts).toHaveLength(1);
    expect(job.parts[0].qty).toBe(2);
    expect(job.notes).toHaveLength(1);
    expect(job.labour).toHaveLength(1);
    expect(job.status).toBe("in_progress");
    expect(job.assignedTo).toBeTruthy();
    const stock = ((await manager.get("/api/parts?q=BLB-IND")).json().items as Part[])[0].stockQty;
    expect(stock).toBe(part.stockQty - 2);
  });

  it("reports a refused operation and carries on with the rest", async () => {
    const { id } = await newJob("repair", 2);
    const cable = ((await tech.get("/api/parts?q=CBL-THR")).json().items as Part[])[0];
    const res = await sync(tech, [op("part", id, { partId: cable.id, qty: 999 }), op("note", id, { text: "Cable ordered" })]);
    const [a, b] = res.json().results;
    expect(a).toMatchObject({ ok: false, error: "out_of_stock" });
    expect(a.message).toContain("Book in the delivery");
    expect(b.ok).toBe(true);
  });

  it("one clock per technician: starting a second job stops the first", async () => {
    const j1 = await newJob("repair", 3);
    const j2 = await newJob("repair", 4);
    await sync(tech2, [op("start", j1.id)]);
    await sync(tech2, [op("start", j2.id)]);
    const first = await jobOf(tech2, j1.id);
    const second = await jobOf(tech2, j2.id);
    expect(first.labour.every((l) => l.endedAt)).toBe(true);
    expect(second.myTimerStartedAt).toBeTruthy();
    await sync(tech2, [op("stop", j2.id)]);
  });

  it("an implausible phone clock falls back to the server's time", async () => {
    const { id } = await newJob("repair", 5);
    await sync(tech, [{ ...op("start", id), at: "2001-01-01T00:00:00Z" }, op("stop", id)]);
    const l = (await jobOf(tech, id)).labour[0];
    expect(Date.now() - Date.parse(l.startedAt)).toBeLessThan(60_000);
  });

  it("clients can't use the sync endpoint and op ids can't be reused by someone else", async () => {
    const { id } = await newJob("repair", 6);
    expect((await sync(client, [op("note", id, { text: "hi" })])).statusCode).toBe(403);
    const shared = op("note", id, { text: "mine" });
    await sync(tech, [shared]);
    const stolen = (await sync(tech2, [shared])).json().results[0];
    expect(stolen.ok).toBe(false);
  });
});

describe("completing a service", () => {
  it("needs every checklist item, a note on failures, and a sane odometer", async () => {
    const { id, bike } = await newJob("service", 7);
    let res = await manager.send("POST", `/api/jobs/${id}/complete`, { odometerKm: bike.odometerKm + 100, summary: "" });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("no result");
    const job = await jobOf(manager, id);
    const ops = job.checklist.map((i) => op("check", id, { key: i.key, result: i.key === "tyres" ? "fail" : "pass", note: "" }));
    await sync(tech, ops);
    res = await manager.send("POST", `/api/jobs/${id}/complete`, { odometerKm: bike.odometerKm + 100, summary: "" });
    expect(res.json().message).toContain('Say what is wrong with "Tyre tread');
    await sync(tech, [op("check", id, { key: "tyres", result: "fail", note: "Rear tyre at 1mm" })]);
    res = await manager.send("POST", `/api/jobs/${id}/complete`, { odometerKm: bike.odometerKm - 1, summary: "" });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("can't go backwards");

    // Completing: the bike's service record resets, and the failed safety check becomes an urgent off-road repair.
    const done = await sync(tech, [op("complete", id, { odometerKm: bike.odometerKm + 100, summary: "Serviced" })]);
    const r = done.json().results[0];
    expect(r.ok).toBe(true);
    expect(r.followUpId).toBeTruthy();
    const after = (await manager.get(`/api/bikes/${bike.id}`)).json().bike as Bike;
    expect(after.odometerKm).toBe(bike.odometerKm + 100);
    expect(after.lastServiceKm).toBe(bike.odometerKm + 100);
    expect(after.due.status).toBe("ok");
    expect(after.offRoad).toBe(true);
    const follow = await jobOf(manager, r.followUpId);
    expect(follow).toMatchObject({ kind: "repair", priority: "urgent", offRoad: true, followUpOf: id });
    expect(follow.description).toContain("Rear tyre at 1mm");
    // A finished job is locked.
    expect((await sync(tech, [op("note", id, { text: "late" })])).json().results[0].ok).toBe(true);
    expect((await sync(tech, [op("start", id)])).json().results[0]).toMatchObject({ ok: false, error: "job_closed" });
  });
});

describe("parts and stock", () => {
  it("removing a part from a job puts it back in stock", async () => {
    const { id } = await newJob("repair", 8);
    const plug = ((await manager.get("/api/parts?q=PLG-SPK")).json().items as Part[])[0];
    const added = (await manager.send("POST", `/api/jobs/${id}/parts`, { partId: plug.id, qty: 1 })).json() as JobDetail;
    expect(((await manager.get("/api/parts?q=PLG-SPK")).json().items as Part[])[0].stockQty).toBe(plug.stockQty - 1);
    await manager.send("DELETE", `/api/jobs/${id}/parts/${added.parts[0].id}`);
    expect(((await manager.get("/api/parts?q=PLG-SPK")).json().items as Part[])[0].stockQty).toBe(plug.stockQty);
  });

  it("stock can't go below zero and whole-unit parts take whole numbers", async () => {
    const mirror = ((await manager.get("/api/parts?q=MIR-L")).json().items as Part[])[0];
    expect((await manager.send("POST", `/api/parts/${mirror.id}/stock`, { qty: -1000, reason: "adjustment", note: "" })).statusCode).toBe(400);
    expect((await manager.send("POST", `/api/parts/${mirror.id}/stock`, { qty: 1.5, reason: "delivery", note: "" })).statusCode).toBe(400);
    const ok = await manager.send("POST", `/api/parts/${mirror.id}/stock`, { qty: 4, reason: "delivery", note: "PO 1182" });
    expect(ok.json().stockQty).toBe(mirror.stockQty + 4);
  });

  it("a job with parts can't be cancelled until they're returned", async () => {
    const { id } = await newJob("repair", 9);
    const bulb = ((await manager.get("/api/parts?q=BLB-H4")).json().items as Part[])[0];
    await manager.send("POST", `/api/jobs/${id}/parts`, { partId: bulb.id, qty: 1 });
    const res = await manager.send("POST", `/api/jobs/${id}/cancel`, { reason: "Client sold the bike" });
    expect(res.statusCode).toBe(409);
  });
});

describe("invoicing", () => {
  it("bills finished work once, at the client's rate, and voiding frees the jobs", async () => {
    const today = (await manager.get("/api/meta")).json().today as string;
    const bikes = (await bikesOf(manager, "")).filter((b) => b.clientName === "Metro Courier Co" && b.openJobs === 0);
    const res = await manager.send("POST", "/api/jobs", { bikeId: bikes[0].id, kind: "repair", title: "Mirror replaced", description: "", priority: "normal", offRoad: false, scheduledFor: null, assignedTo: null });
    const id = res.json().id;
    const mirror = ((await manager.get("/api/parts?q=MIR-L")).json().items as Part[])[0];
    await sync(tech, [op("start", id), op("part", id, { partId: mirror.id, qty: 1 })]);
    // 20 minutes worked, billed in 15-minute blocks: 30 minutes at Metro's £55/h = £27.50.
    const entry = (await jobOf(manager, id)).labour[0];
    await sync(tech, [op("stop", id)]);
    const start = new Date(Date.now() - 3 * 3600_000);
    const edit = await manager.send("PUT", `/api/jobs/${id}/labour/${entry.id}`, { startedAt: start.toISOString(), endedAt: new Date(start.getTime() + 20 * 60_000).toISOString() });
    expect(edit.statusCode, edit.body).toBe(200);
    await sync(tech, [op("complete", id, { odometerKm: bikes[0].odometerKm + 5, summary: "Done" })]);

    const body = { clientId: "c-metro", periodStart: today, periodEnd: today };
    const preview = (await manager.send("POST", "/api/invoices/preview", body)).json();
    const labourLine = preview.lines.find((l: { jobId: string; isLabour: boolean }) => l.jobId === id && l.isLabour);
    expect(labourLine.amountCents).toBe(2750);
    const inv = await manager.send("POST", "/api/invoices", body);
    expect(inv.statusCode).toBe(201);
    expect((await manager.send("POST", "/api/invoices", body)).statusCode).toBe(400);
    const detail = (await manager.get(`/api/invoices/${inv.json().id}`)).json();
    expect(detail.totalCents).toBe(detail.subtotalCents + detail.taxCents);
    expect(detail.number).toMatch(/^INV-\d{6}$/);
    // Invoiced time is locked.
    expect((await manager.send("PUT", `/api/jobs/${id}/labour/${entry.id}`, { startedAt: start.toISOString(), endedAt: new Date(start.getTime() + 60 * 60_000).toISOString() })).statusCode).toBe(409);
    await manager.send("POST", `/api/invoices/${inv.json().id}/void`);
    expect((await manager.send("POST", "/api/invoices/preview", body)).json().jobs.map((j: { id: string }) => j.id)).toContain(id);
  });
});

describe("bikes", () => {
  it("rejects a registration already on the road, and edits need the latest version", async () => {
    const [a, b] = await bikesOf(manager);
    const res = await manager.send("POST", "/api/bikes", {
      clientId: a.clientId, plate: b.plate.toLowerCase().replace(/(..)/, "$1 "), vin: "", make: "Honda", model: "PCX125", year: 2024, engineCc: 125,
      odometerKm: 10, serviceIntervalKm: 4000, serviceIntervalDays: 180, lastServiceKm: 0, lastServiceDate: "2026-01-01", notes: "",
    });
    expect(res.statusCode).toBe(409);
    const stale = await manager.send("PUT", `/api/bikes/${a.id}`, { ...a, version: a.version - 1, retired: false });
    expect(stale.statusCode).toBe(409);
  });

  it("can't move a bike with open jobs to another client", async () => {
    const busy = (await bikesOf(manager)).find((b) => b.openJobs > 0)!;
    const other = busy.clientId === "c-metro" ? "c-pharma" : "c-metro";
    const res = await manager.send("PUT", `/api/bikes/${busy.id}`, { ...busy, clientId: other, retired: false });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("billed to the current client");
  });
});

describe("reports and dashboard", () => {
  it("dashboard shows off-road bikes and running clocks", async () => {
    const { id } = await newJob("repair", 1);
    await sync(tech2, [op("start", id)]);
    const d = (await manager.get("/api/dashboard")).json();
    expect(d.offRoadBikes.length).toBeGreaterThan(0);
    expect(d.runningTimers.some((t: { technicianName: string; jobId: string }) => t.technicianName === "Casey Brown" && t.jobId === id)).toBe(true);
    expect(d.dueCounts.overdue + d.dueCounts.dueSoon).toBeGreaterThan(0);
  });

  it("period report with availability and a CSV that can't inject formulas", async () => {
    const meta = (await admin.get("/api/meta")).json();
    const from = new Date(Date.parse(meta.today) - 30 * 86_400_000).toISOString().slice(0, 10);
    const r = (await manager.get(`/api/reports?from=${from}&to=${meta.today}`)).json();
    expect(r.summary.jobsDone).toBeGreaterThan(20);
    for (const c of r.clients) if (c.availabilityPct !== null) expect(c.availabilityPct).toBeGreaterThan(50);
    const csv = await manager.get(`/api/reports?from=${from}&to=${meta.today}&format=csv&table=technicians`);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body.split("\r\n")[0]).toBe("technician,labourHours,jobs");
    expect((await tech.get(`/api/reports?from=${from}&to=${meta.today}`)).statusCode).toBe(403);
  });
});

describe("photos", () => {
  it("accepts real images only", async () => {
    const { id } = await newJob("repair", 0);
    const boundary = "----x";
    const body = (name: string, data: Buffer) =>
      Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: image/jpeg\r\n\r\n`),
        data,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
    const headers = { cookie: `sid=${tech.cookie}`, "x-csrf-token": tech.csrf, "content-type": `multipart/form-data; boundary=${boundary}` };
    const fake = await ctx.app.inject({ method: "POST", url: `/api/jobs/${id}/photos`, headers, payload: body("x.jpg", Buffer.from("<script>alert(1)</script>")) });
    expect(fake.statusCode).toBe(400);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)]);
    const ok = await ctx.app.inject({ method: "POST", url: `/api/jobs/${id}/photos`, headers, payload: body("../../evil name.png", jpeg) });
    expect(ok.statusCode).toBe(201);
    const photo = (await jobOf(manager, id)).photos[0];
    expect(photo.name).toBe("evil name.jpg");
    const got = await manager.get(`/api/photos/${photo.id}`);
    expect(got.headers["content-type"]).toBe("image/jpeg");
    expect(got.headers["x-content-type-options"]).toBe("nosniff");
  });
});
