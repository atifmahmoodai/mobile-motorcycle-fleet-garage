import { z } from "zod";

// Input rules shared by the API (enforced) and the web app (early feedback).

const text = (max: number) => z.string().trim().max(max);
const cents = z.number().int().min(0).max(1_000_000_000);
const id = z.string().trim().min(1).max(64);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const optionalEmail = z.union([z.literal(""), z.string().trim().toLowerCase().email().max(200)]).transform((v) => v || null);
const phone = text(40).refine((p) => p === "" || /^[\d\s+()\-.]{6,40}$/.test(p), "Enter a phone number with digits");

/** Staff roles plus "client": a fleet customer's manager, who sees only their own bikes. */
export const ROLES = ["admin", "manager", "technician", "client"] as const;
export type Role = (typeof ROLES)[number];
export const STAFF: Role[] = ["admin", "manager", "technician"];

export const loginSchema = z.object({ email: z.string().trim().toLowerCase().email().max(200), password: z.string().min(1).max(200) });
export const passwordSchema = z
  .string()
  .min(10, "At least 10 characters")
  .max(200)
  .refine((p) => /[a-z]/i.test(p) && /\d/.test(p), "Use letters and at least one number");
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(200), newPassword: passwordSchema });
const userFields = {
  name: text(120).min(2),
  role: z.enum(ROLES),
  clientId: id.nullable(),
};
const clientRule = (u: { role: Role; clientId: string | null }) => (u.role === "client") === (u.clientId !== null);
const clientRuleMsg = { message: "Client logins need a client; staff logins must not have one", path: ["clientId"] };
export const userCreateSchema = z
  .object({ email: z.string().trim().toLowerCase().email().max(200), password: passwordSchema, ...userFields })
  .refine(clientRule, clientRuleMsg);
export const userUpdateSchema = z.object({ ...userFields, active: z.boolean() }).refine(clientRule, clientRuleMsg);
export const resetPasswordSchema = z.object({ password: passwordSchema });

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  clientId: string | null;
}

export const checklistTemplateSchema = z
  .array(z.object({ key: z.string().regex(/^[a-z0-9_]{1,40}$/), label: text(80).min(1), safety: z.boolean() }))
  .min(1)
  .max(40)
  .refine((items) => new Set(items.map((i) => i.key)).size === items.length, "Each checklist item needs its own key");

export const settingsSchema = z.object({
  companyName: text(120).min(1),
  companyAddress: text(300),
  currency: z.string().regex(/^[A-Z]{3}$/, "3-letter code like GBP"),
  locale: z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, "Like en-GB"),
  taxPercent: z.number().min(0).max(30),
  /** Default labour rate per hour; a client can have its own. */
  labourRateCents: cents,
  /** Labour is billed in blocks of this many minutes, rounded up per job. */
  labourBlockMinutes: z.number().int().min(1).max(60),
  paymentTermsDays: z.number().int().min(0).max(120),
  dueSoonKm: z.number().int().min(0).max(5000),
  dueSoonDays: z.number().int().min(0).max(60),
  serviceChecklist: checklistTemplateSchema,
  inspectionChecklist: checklistTemplateSchema,
});

// ---- clients and bikes ----
export const clientSchema = z.object({
  name: text(120).min(2, "Enter the client's name"),
  contactName: text(120),
  email: optionalEmail,
  phone,
  address: text(300),
  /** null uses the default rate from settings. */
  labourRateCents: cents.nullable(),
  active: z.boolean().default(true),
});

export const normalisePlate = (p: string) => p.toUpperCase().replace(/[^A-Z0-9]/g, "");

export const bikeSchema = z
  .object({
    clientId: id,
    plate: text(16).transform(normalisePlate).refine((p) => p.length >= 2, "Enter the registration"),
    vin: text(20).transform((v) => v.toUpperCase()),
    make: text(40).min(1, "Enter the make"),
    model: text(60).min(1, "Enter the model"),
    year: z.number().int().min(1980).max(2100),
    engineCc: z.number().int().min(0).max(3000),
    odometerKm: z.number().int().min(0).max(2_000_000),
    serviceIntervalKm: z.number().int().min(100).max(100_000),
    serviceIntervalDays: z.number().int().min(7).max(730),
    lastServiceKm: z.number().int().min(0).max(2_000_000),
    lastServiceDate: isoDate,
    notes: text(1000),
  })
  .refine((b) => b.lastServiceKm <= b.odometerKm, { message: "Can't be more than the odometer", path: ["lastServiceKm"] });
export const bikeUpdateSchema = z.intersection(bikeSchema, z.object({ version: z.number().int(), retired: z.boolean() }));

// ---- jobs ----
export const JOB_KINDS = ["service", "inspection", "repair", "defect"] as const;
export const JOB_STATUSES = ["open", "scheduled", "in_progress", "waiting_parts", "done", "cancelled"] as const;
export const PRIORITIES = ["low", "normal", "urgent"] as const;
export type JobKind = (typeof JOB_KINDS)[number];
export type JobStatus = (typeof JOB_STATUSES)[number];
export type Priority = (typeof PRIORITIES)[number];
export const OPEN_STATUSES: JobStatus[] = ["open", "scheduled", "in_progress", "waiting_parts"];

export const jobCreateSchema = z.object({
  bikeId: id,
  kind: z.enum(JOB_KINDS),
  priority: z.enum(PRIORITIES).default("normal"),
  title: text(120).min(3, "Say what the job is"),
  description: text(2000),
  /** The bike must not be ridden until this job is done. */
  offRoad: z.boolean().default(false),
  scheduledFor: isoDate.nullable().default(null),
  assignedTo: id.nullable().default(null),
});
export const jobUpdateSchema = z.object({
  version: z.number().int(),
  priority: z.enum(PRIORITIES),
  title: text(120).min(3),
  description: text(2000),
  offRoad: z.boolean(),
  scheduledFor: isoDate.nullable(),
  assignedTo: id.nullable(),
});
/** What a fleet client can send: a defect report on one of their bikes. */
export const defectReportSchema = z.object({
  bikeId: id,
  title: text(120).min(3, "Say what is wrong"),
  description: text(2000),
  offRoad: z.boolean(),
});

export const CHECK_RESULTS = ["pass", "fail", "na"] as const;
export type CheckResult = (typeof CHECK_RESULTS)[number];

export const labourEditSchema = z
  .object({ startedAt: z.string().datetime({ offset: true }), endedAt: z.string().datetime({ offset: true }) })
  .refine((l) => Date.parse(l.endedAt) > Date.parse(l.startedAt), { message: "Ends before it starts", path: ["endedAt"] })
  .refine((l) => Date.parse(l.endedAt) - Date.parse(l.startedAt) <= 16 * 3600_000, { message: "Longer than 16 hours", path: ["endedAt"] });

// ---- technician app operations: queued on the phone when offline and replayed; each has a phone-made id ----
const opBase = { opId: z.string().uuid(), jobId: id, at: z.string().datetime({ offset: true }) };
export const techOpSchema = z.discriminatedUnion("type", [
  z.object({ ...opBase, type: z.literal("start") }),
  z.object({ ...opBase, type: z.literal("stop") }),
  z.object({ ...opBase, type: z.literal("check"), key: z.string().max(40), result: z.enum(CHECK_RESULTS).nullable(), note: text(300) }),
  z.object({ ...opBase, type: z.literal("part"), partId: id, qty: z.number().positive().max(1000) }),
  z.object({ ...opBase, type: z.literal("note"), text: text(2000).min(1) }),
  z.object({ ...opBase, type: z.literal("waiting_parts") }),
  z.object({ ...opBase, type: z.literal("complete"), odometerKm: z.number().int().min(0).max(2_000_000), summary: text(2000) }),
]);
export type TechOp = z.infer<typeof techOpSchema>;
export const techSyncSchema = z.object({ ops: z.array(techOpSchema).min(1).max(200) });

// ---- parts ----
export const partSchema = z.object({
  sku: text(40).min(1).transform((s) => s.toUpperCase()),
  name: text(120).min(2),
  unit: z.enum(["each", "litre", "metre"]),
  minQty: z.number().min(0).max(100_000),
  costCents: cents,
  priceCents: cents,
  active: z.boolean().default(true),
});
export const stockMoveSchema = z.object({
  qty: z.number().refine((q) => q !== 0 && Math.abs(q) <= 100_000, "Enter a quantity"),
  reason: z.enum(["delivery", "adjustment", "return"]),
  note: text(200),
});

// ---- invoices ----
export const invoiceRunSchema = z.object({ clientId: id, periodStart: isoDate, periodEnd: isoDate }).refine((r) => r.periodStart <= r.periodEnd, {
  message: "The period ends before it starts",
  path: ["periodEnd"],
});
