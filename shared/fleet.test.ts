import { describe, expect, it } from "vitest";
import { billableMinutes, checklistProblems, coveredHours, failedSafetyItems, invoiceLines, invoiceTotals, labourCents, serviceDue, type CheckItem } from "./fleet";
import { bikeSchema, normalisePlate, userCreateSchema } from "./schemas";
import { csvCell } from "./csv";

const bike = { odometerKm: 10_000, lastServiceKm: 7_000, lastServiceDate: "2026-06-01", serviceIntervalKm: 4000, serviceIntervalDays: 180 };
const soon = { km: 500, days: 14 };

describe("service due", () => {
  it("is ok, due soon or overdue by distance", () => {
    expect(serviceDue(bike, "2026-07-01", soon)).toMatchObject({ status: "ok", kmLeft: 1000 });
    expect(serviceDue({ ...bike, odometerKm: 10_600 }, "2026-07-01", soon).status).toBe("due_soon");
    expect(serviceDue({ ...bike, odometerKm: 11_000 }, "2026-07-01", soon).status).toBe("overdue");
  });
  it("or by time, whichever comes first", () => {
    expect(serviceDue(bike, "2026-11-20", soon)).toMatchObject({ status: "due_soon", dueDate: "2026-11-28" });
    expect(serviceDue(bike, "2026-11-28", soon).status).toBe("overdue");
  });
});

describe("checklists", () => {
  const item = (key: string, result: CheckItem["result"], note = "", safety = true): CheckItem => ({ key, label: key, safety, result, note });
  it("needs a result on every item and a note on each failure", () => {
    expect(checklistProblems([item("a", "pass"), item("b", null)])[0]).toContain("1 checklist item has no result: b");
    expect(checklistProblems([item("a", "fail")])).toEqual(['Say what is wrong with "a"']);
    expect(checklistProblems([item("a", "fail", "worn"), item("b", "na")])).toEqual([]);
  });
  it("picks out failed safety items only", () => {
    expect(failedSafetyItems([item("a", "fail", "x"), item("b", "fail", "y", false), item("c", "pass")]).map((i) => i.key)).toEqual(["a"]);
  });
});

describe("labour and invoices", () => {
  it("rounds time up to the billing block", () => {
    expect(billableMinutes(0, 15)).toBe(0);
    expect(billableMinutes(1, 15)).toBe(15);
    expect(billableMinutes(15, 15)).toBe(15);
    expect(billableMinutes(16, 15)).toBe(30);
    expect(labourCents(20, 5500, 15)).toBe(2750);
  });
  it("makes lines whose quantity times price equals the amount, and totals with tax", () => {
    const lines = invoiceLines(
      [{ jobId: "j1", number: "JB-000001", plate: "LK21ABC", title: "Brakes", minutes: 20, parts: [{ name: "Pads", qty: 2, unitPriceCents: 2200 }] }],
      6000,
      15,
    );
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(Math.round(l.qty * l.unitCents)).toBe(l.amountCents);
    expect(lines[0]).toMatchObject({ isLabour: true, amountCents: 3000 });
    expect(invoiceTotals(lines, 20)).toEqual({ subtotalCents: 7400, taxCents: 1480, totalCents: 8880 });
  });
  it("a job with no time and no parts adds nothing", () => {
    expect(invoiceLines([{ jobId: "j", number: "n", plate: "p", title: "t", minutes: 0, parts: [] }], 6000, 15)).toEqual([]);
  });
});

describe("downtime", () => {
  const h = 3_600_000;
  it("counts overlapping off-road periods once and clips to the period", () => {
    const intervals = [{ start: 0, end: 5 * h }, { start: 3 * h, end: 8 * h }, { start: 20 * h, end: null }];
    expect(coveredHours(intervals, 2 * h, 24 * h, 22 * h)).toBe(6 + 2);
  });
});

describe("input rules", () => {
  it("normalises registrations", () => {
    expect(normalisePlate(" lk21 abc ")).toBe("LK21ABC");
  });
  it("a client login needs a client and staff must not have one", () => {
    const base = { email: "a@b.co", password: "password123", name: "Ann Other" };
    expect(userCreateSchema.safeParse({ ...base, role: "client", clientId: null }).success).toBe(false);
    expect(userCreateSchema.safeParse({ ...base, role: "technician", clientId: "c1" }).success).toBe(false);
    expect(userCreateSchema.safeParse({ ...base, role: "client", clientId: "c1" }).success).toBe(true);
  });
  it("last service can't be beyond the odometer", () => {
    const b = { clientId: "c", plate: "AB12CDE", vin: "", make: "Honda", model: "PCX", year: 2024, engineCc: 125, odometerKm: 100, serviceIntervalKm: 4000, serviceIntervalDays: 180, lastServiceKm: 200, lastServiceDate: "2026-01-01", notes: "" };
    expect(bikeSchema.safeParse(b).success).toBe(false);
  });
  it("CSV cells can't start a formula", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
  });
});
