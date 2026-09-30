// End-to-end smoke test of the whole stack: a fresh PostgreSQL database with demo data, the built
// API server serving the built web app, and each role's day driven in Chromium: the manager, a
// technician on a phone (including losing signal mid-job) and a fleet client.
//   npm run build && npm run smoke        (from the project root)
// Uses SMOKE_DATABASE_URL (default postgres://postgres:postgres@localhost:5432/fleet_smoke).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { chromium } from "playwright-core";

const PORT = 4189;
const BASE = `http://localhost:${PORT}/`;
const SHOTS = "test-results/screenshots";
const DB_URL = process.env.SMOKE_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/fleet_smoke";
const executablePath = process.env.CHROMIUM_PATH || (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
mkdirSync(SHOTS, { recursive: true });
if (!existsSync("../server/dist/server.js") || !existsSync("dist/index.html")) throw new Error("Build first: npm run build (from the project root)");

{
  const name = new URL(DB_URL).pathname.slice(1);
  if (!/^[a-z0-9_]+$/.test(name) || !name.includes("smoke")) throw new Error("SMOKE_DATABASE_URL must name a database containing 'smoke'");
  const adminUrl = new URL(DB_URL);
  adminUrl.pathname = "/postgres";
  const c = new pg.Client({ connectionString: adminUrl.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await c.query(`CREATE DATABASE ${name}`);
  await c.end();
}
const env = { ...process.env, NODE_ENV: "production", DATABASE_URL: DB_URL, PORT: String(PORT), PUBLIC_URL: BASE, COOKIE_SECURE: "false", WEB_DIST: join(process.cwd(), "dist"), LOG_LEVEL: "warn", ALLOW_DEMO_SEED: "1" };
const seeded = spawnSync("node", ["../server/dist/cli/seed-demo.js"], { env, encoding: "utf8" });
if (seeded.status !== 0) throw new Error(`demo seed failed: ${seeded.stderr}`);
const server = spawn("node", ["../server/dist/server.js"], { env, stdio: ["ignore", "inherit", "inherit"] });

let failures = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "✓" : "✗"} ${msg}`);
  if (!ok) failures++;
};
const money = (s) => Number(s.replace(/[^\d.-]/g, ""));
const signIn = async (p, email) => {
  await p.goto(`${BASE}login`);
  await p.fill("input[type=email]", email);
  await p.fill("input[type=password]", "demo-password-1");
  await p.click("button:has-text('Sign in')");
  await p.waitForSelector(".appbar");
};
const signOut = async (p) => {
  await p.click("button:has-text('Sign out')");
  await p.waitForURL(/\/login/);
};
const pickCustomer = async (p, scope, name) => {
  await p.fill(`${scope} input[aria-label='Search customers']`, name.slice(0, 5));
  await p.locator(`${scope} .pick-list button:has-text('${name}')`).first().click();
};

let page;
try {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${BASE}readyz`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch({ executablePath });
  const errors = [];
  const watch = (p) => {
    p.on("pageerror", (e) => {
      errors.push(e.stack || e.message);
      console.log(`  ! ${e.stack || e.message}`);
    });
    // 4xx answers are expected here (refused actions, validation); any 5xx or script error is a failure.
    p.on("console", (m) => m.type() === "error" && !/status of 4\d\d|ERR_INTERNET_DISCONNECTED/.test(m.text()) && errors.push(`${p.url()}: ${m.text()}`));
    p.on("dialog", (d) => (d.type() === "prompt" ? d.accept("Bike sold by the client") : d.accept()));
  };
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  page = await ctx.newPage();
  watch(page);

  const api = async (p, path) => p.evaluate(async (u) => (await fetch(u)).json(), `/api${path}`);

  console.log("Manager");
  await signIn(page, "manager@demo.local");
  await page.waitForSelector("h1:has-text('Workshop today')");
  check((await page.title()) === "Fleet Garage", "browser tab title");
  const offRoad = await page.locator(".kpi", { hasText: "Bikes off the road" }).locator(".kpi-value").innerText();
  check(Number(offRoad) >= 3, `dashboard counts bikes off the road (${offRoad})`);
  check(await page.locator("text=Jordan Lee").first().isVisible(), "running clock shown on the dashboard");
  await page.goto(`${BASE}bikes?due=attention`);
  await page.waitForSelector("table tbody tr");
  check((await page.locator("tbody tr").count()) > 3, "bikes needing attention listed");
  // New job for a bike, assigned to Jordan.
  await page.goto(`${BASE}jobs`);
  await page.click("button:has-text('New job')");
  const bikeOpt = await page.locator(".modal select >> nth=0").locator("option").nth(20).getAttribute("value");
  await page.selectOption(".modal select >> nth=0", bikeOpt);
  await page.selectOption(".modal label:has-text('Technician') select", { label: "Jordan Lee" });
  await page.click(".modal button:has-text('Create job')");
  await page.waitForURL(/\/jobs\/j-/);
  const jobUrl = page.url();
  const jobId = jobUrl.split("/").pop();
  await page.waitForSelector("h1:has-text('Scheduled service')");
  check(true, "service job created and opened");
  check((await page.locator("table select").count()) === 12, "service job has the 12-item checklist");
  await signOut(page);

  console.log("Technician on a phone");
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phone = await phoneCtx.newPage();
  watch(phone);
  await signIn(phone, "tech@demo.local");
  await phone.waitForURL(/\/tech$/);
  await phone.waitForSelector(".tech-list");
  await phone.click(`a[href='/tech/${jobId}']`);
  await phone.waitForSelector("button:has-text('Start clock')");
  await phone.click("button:has-text('Start clock')");
  await phone.waitForSelector("button:has-text('Stop clock')");
  // Everything passes except the tyres, which fail.
  for (const item of await phone.locator(".checklist li").all()) {
    const label = await item.locator(".grow").innerText();
    await item.locator(`button:text-is("${label.startsWith("Tyre") ? "Fail" : "Pass"}")`).click();
  }
  await phone.fill("input[placeholder='What is wrong?']", "Rear tyre 1.2mm, needs replacing");
  await phone.locator("input[placeholder='What is wrong?']").blur();
  await phone.fill("input[aria-label='Find a part']", "oil filter");
  await phone.click(".card:has-text('Parts used') li button:has-text('Add')");
  await phone.waitForSelector("text=/1 × FLT-OIL-PCX/");
  await phone.waitForFunction(() => !document.querySelector(".notice"), null, { timeout: 10_000 });
  check(true, "clock, checklist and part sent");

  // Signal drops in the workshop: the note waits on the phone, then goes when signal is back.
  await phoneCtx.setOffline(true);
  await phone.fill("textarea[aria-label='Add a note']", "Chain adjusted two flats.");
  await phone.click("button:has-text('Save note')");
  await phone.waitForSelector("text=Offline — changes are saved on this phone");
  check(await phone.locator("text=(not sent yet)").isVisible(), "offline note shown as not sent yet");
  await phone.reload().catch(() => {});
  await phoneCtx.setOffline(false);
  await phone.reload();
  await phone.waitForSelector(".checklist");
  await phone.waitForFunction(() => !document.querySelector(".notice"), null, { timeout: 20_000 });
  const serverJob = await api(phone, `/jobs/${jobId}`);
  check(serverJob.notes.some((n) => n.text === "Chain adjusted two flats."), "queued note reached the server after signal returned");
  check(serverJob.notes.filter((n) => n.text === "Chain adjusted two flats.").length === 1, "and only once");

  // A refused action is shown, not retried forever.
  await phone.fill("input[aria-label='Find a part']", "throttle");
  await phone.fill("input[aria-label='Quantity']", "50");
  await phone.click(".card:has-text('Parts used') li button:has-text('Add')");
  await phone.waitForSelector(".notice-bad:has-text('Not saved')");
  check(await phone.locator(".notice-bad:has-text('Book in the delivery')").isVisible(), "out-of-stock part reported to the technician");
  await phone.click(".notice-bad button:has-text('OK')");

  // Sign off: the failed tyre check puts the bike under an urgent follow-up repair.
  const bike = await api(phone, `/bikes/${serverJob.bikeId}`);
  await phone.fill("label:has-text('Odometer') input", String(bike.bike.odometerKm + 42));
  await phone.fill("label:has-text('Work done') textarea", "Serviced. Rear tyre needs replacing.");
  await phone.click("button:has-text('Sign off job')");
  await phone.waitForFunction(() => !document.querySelector(".notice"), null, { timeout: 10_000 });
  const done = await api(phone, `/jobs/${jobId}`);
  check(done.status === "done" && done.odometerKm === bike.bike.odometerKm + 42, "job signed off with the odometer");
  const after = await api(phone, `/bikes/${serverJob.bikeId}`);
  check(after.bike.offRoad && after.jobs.some((j) => j.title === `Fix failed checks from ${done.number}` && j.priority === "urgent" && j.status === "open"), "bike kept off the road by a follow-up repair");
  const phoneOverflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(phoneOverflow <= 0, `technician screen fits the phone (${phoneOverflow}px)`);
  await phone.screenshot({ path: `${SHOTS}/tech-phone.png`, fullPage: true });
  await phoneCtx.close();

  console.log("Fleet client");
  await signIn(page, "client@demo.local");
  await page.waitForURL(/\/bikes$/);
  await page.waitForSelector("tbody tr");
  check((await page.locator("tbody tr").count()) === 16, "client sees exactly their 16 bikes");
  check(!(await page.locator("nav >> text=Parts").count()), "no parts screen for clients");
  await page.click("tbody tr >> nth=5 >> a.plate");
  await page.click("button:has-text('Report a problem')");
  await page.fill(".modal input", "Horn not working");
  await page.check(".modal input[type=checkbox]");
  await page.click("button:has-text('Send to the workshop')");
  await page.waitForURL(/\/jobs\/j-/);
  await page.waitForSelector("h1:has-text('Horn not working')");
  check(await page.locator(".badge:has-text('Urgent')").isVisible() && (await page.locator(".badge:has-text('Off road')").count()) > 0, "client's unsafe-bike report is urgent and off the road");
  check(!(await page.locator("text=Workshop notes").count()), "client doesn't see workshop notes");
  await page.goto(`${BASE}invoices`);
  await page.waitForSelector("tbody tr");
  check((await page.locator("tbody tr").count()) >= 1, "client sees their invoices");
  await signOut(page);

  console.log("Invoicing");
  await signIn(page, "manager@demo.local");
  await page.goto(`${BASE}invoices`);
  await page.click("button:has-text('Invoice a client')");
  await page.selectOption(".modal select", { label: after.bike.clientName });
  const today = (await api(page, "/meta")).today;
  await page.locator(".modal input[type=date]").nth(0).fill(today);
  await page.locator(".modal input[type=date]").nth(1).fill(today);
  await page.click("button:has-text('Show what would be billed')");
  await page.waitForSelector(".modal button:has-text('Issue invoice')");
  check(await page.locator(`.modal td:has-text('${done.number}')`).first().isVisible(), "today's signed-off job is in the invoice preview");
  await page.click(".modal button:has-text('Issue invoice')");
  await page.waitForURL(/\/invoices\/inv-/);
  await page.waitForSelector(".doc-lines");
  check(await page.locator("h2:has-text('Invoice INV-')").isVisible(), "invoice issued with a number");
  check(!(await page.locator(".appbar").count()), "invoice page prints without the navigation");
  await page.screenshot({ path: `${SHOTS}/invoice.png`, fullPage: true });

  console.log("Reports and settings");
  await page.goto(`${BASE}reports`);
  await page.waitForSelector("text=Availability");
  check((await page.locator("section:has(h2:text-is('Clients')) tbody tr").count()) === 3, "availability per client");
  await page.goto(`${BASE}jobs/${jobId}`);
  await page.waitForSelector("h1");
  check(await page.locator("text=Chain adjusted two flats.").isVisible(), "manager sees the technician's note");
  await page.screenshot({ path: `${SHOTS}/job.png`, fullPage: true });
  await signOut(page);
  await signIn(page, "admin@demo.local");
  await page.goto(`${BASE}settings`);
  await page.waitForSelector("text=Service checklist");
  await page.goto(`${BASE}audit`);
  await page.waitForSelector("td:has-text('Signed off job')");
  check(true, "activity log records sign-offs");
  await page.goto(BASE);
  await page.waitForSelector("h1:has-text('Workshop today')");
  await page.screenshot({ path: `${SHOTS}/dashboard.png`, fullPage: true });

  console.log("Phone layout");
  const m = await (await browser.newContext({ viewport: { width: 375, height: 800 }, colorScheme: "dark" })).newPage();
  watch(m);
  await signIn(m, "manager@demo.local");
  for (const r of ["", "jobs", "bikes", "parts", "invoices", "reports", `jobs/${jobId}`]) {
    await m.goto(`${BASE}${r}`);
    await m.waitForSelector("main h1");
    const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 0, `no page-level horizontal scroll on phone at "/${r}" (${overflow}px)`);
  }

  console.log("Server");
  const res = await fetch(`${BASE}jobs/abc`);
  check(res.ok && (await res.text()).includes('id="root"'), "deep links serve the app");
  check(!!res.headers.get("content-security-policy"), "security headers set");
  const nf = await fetch(`${BASE}api/nope`);
  check(nf.status === 404 && (nf.headers.get("content-type") ?? "").includes("json"), "unknown API paths are JSON 404s");

  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
  await browser.close();
} catch (e) {
  failures++;
  console.error(e);
  if (page) {
    console.error("URL at failure:", page.url());
    await page.screenshot({ path: `${SHOTS}/failure.png`, fullPage: true }).catch(() => {});
  }
} finally {
  server.kill("SIGTERM");
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll smoke checks passed");
process.exit(failures ? 1 : 0);
