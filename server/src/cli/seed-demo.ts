// Loads a demo fleet garage: three fleet clients, their bikes, staff, parts, job history and invoices.
//   npm run seed:demo            refuses if the database already has bikes
//   npm run seed:demo -- --force replaces all business data
// Demo users log in with DEMO_PASSWORD (default: demo-password-1).
import { parseArgs } from "node:util";
import { loadConfig } from "../config";
import { createPool, tx } from "../db";
import { migrate } from "../migrate";
import { seedDemo } from "../seed";

const { values } = parseArgs({ options: { force: { type: "boolean", default: false } } });
const config = loadConfig();
if (config.NODE_ENV === "production" && !process.env.ALLOW_DEMO_SEED) {
  console.error("Refusing to load demo data with NODE_ENV=production. Set ALLOW_DEMO_SEED=1 if you really mean it.");
  process.exit(1);
}
const db = createPool(config.DATABASE_URL, 2);
try {
  await migrate(db);
  const summary = await tx(db, (c) => seedDemo(c, { now: new Date(), timeZone: config.TIMEZONE, force: values.force!, password: process.env.DEMO_PASSWORD ?? "demo-password-1" }));
  console.log(summary);
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await db.end();
}
