// Domain rules shared by the API and the web app. Pure functions, unit-tested in fleet.test.ts.
import type { CheckResult } from "./schemas";
import type { Settings } from "./types";

export const DEFAULT_SETTINGS: Settings = {
  companyName: "Fleet Garage",
  companyAddress: "",
  currency: "GBP",
  locale: "en-GB",
  taxPercent: 20,
  labourRateCents: 6000,
  labourBlockMinutes: 15,
  paymentTermsDays: 30,
  dueSoonKm: 500,
  dueSoonDays: 14,
  serviceChecklist: [
    { key: "oil", label: "Engine oil and filter", safety: false },
    { key: "brakes_front", label: "Front brake pads and disc", safety: true },
    { key: "brakes_rear", label: "Rear brake pads and disc", safety: true },
    { key: "brake_fluid", label: "Brake fluid level and condition", safety: true },
    { key: "chain", label: "Chain tension, wear and lubrication", safety: true },
    { key: "tyres", label: "Tyre tread, damage and pressures", safety: true },
    { key: "lights", label: "Lights, indicators and horn", safety: true },
    { key: "steering", label: "Steering head bearings", safety: true },
    { key: "suspension", label: "Suspension and leaks", safety: false },
    { key: "battery", label: "Battery and charging", safety: false },
    { key: "cables", label: "Throttle and clutch cables", safety: true },
    { key: "test_ride", label: "Test ride", safety: true },
  ],
  inspectionChecklist: [
    { key: "brakes", label: "Brakes", safety: true },
    { key: "tyres", label: "Tyres", safety: true },
    { key: "chain", label: "Chain and sprockets", safety: true },
    { key: "lights", label: "Lights, indicators and horn", safety: true },
    { key: "mirrors", label: "Mirrors and controls", safety: true },
    { key: "bodywork", label: "Bodywork and luggage box", safety: false },
  ],
};

// ---- servicing ----

export type DueStatus = "ok" | "due_soon" | "overdue";

export interface ServiceDue {
  status: DueStatus;
  kmLeft: number;
  daysLeft: number;
  dueDate: string;
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

/** A bike is due by distance or by time, whichever comes first. */
export function serviceDue(
  bike: { odometerKm: number; lastServiceKm: number; lastServiceDate: string; serviceIntervalKm: number; serviceIntervalDays: number },
  today: string,
  soon: { km: number; days: number },
): ServiceDue {
  const kmLeft = bike.serviceIntervalKm - (bike.odometerKm - bike.lastServiceKm);
  const dueDate = addDays(bike.lastServiceDate, bike.serviceIntervalDays);
  const daysLeft = daysBetween(today, dueDate);
  const status: DueStatus = kmLeft <= 0 || daysLeft <= 0 ? "overdue" : kmLeft <= soon.km || daysLeft <= soon.days ? "due_soon" : "ok";
  return { status, kmLeft, daysLeft, dueDate };
}

// ---- checklists ----

export interface CheckItem {
  key: string;
  label: string;
  safety: boolean;
  result: CheckResult | null;
  note: string;
}

export function newChecklist(template: Settings["serviceChecklist"]): CheckItem[] {
  return template.map((t) => ({ ...t, result: null, note: "" }));
}

/** Why a checklist can't be signed off yet; empty when it can. */
export function checklistProblems(items: CheckItem[]): string[] {
  const out: string[] = [];
  const unchecked = items.filter((i) => i.result === null);
  if (unchecked.length) out.push(`${unchecked.length} checklist item${unchecked.length === 1 ? " has" : "s have"} no result: ${unchecked.map((i) => i.label).join(", ")}`);
  for (const i of items) if (i.result === "fail" && !i.note.trim()) out.push(`Say what is wrong with "${i.label}"`);
  return out;
}

/** Safety items that failed: the bike needs a follow-up repair before it goes back on the road. */
export const failedSafetyItems = (items: CheckItem[]) => items.filter((i) => i.safety && i.result === "fail");

// ---- money ----

/** Minutes billed for a job: the time worked rounded up to the billing block. */
export function billableMinutes(minutes: number, block: number): number {
  if (minutes <= 0) return 0;
  return Math.ceil(minutes / block) * block;
}

export function labourCents(minutes: number, ratePerHourCents: number, block: number): number {
  return Math.round((billableMinutes(minutes, block) * ratePerHourCents) / 60);
}

export interface InvoiceLine {
  jobId: string | null;
  description: string;
  qty: number;
  unitCents: number;
  amountCents: number;
  isLabour: boolean;
}

export interface InvoiceJob {
  jobId: string;
  number: string;
  plate: string;
  title: string;
  minutes: number;
  parts: { name: string; qty: number; unitPriceCents: number }[];
}

/** Invoice lines for a client's finished jobs: a labour line and one line per part, per job. */
export function invoiceLines(jobs: InvoiceJob[], ratePerHourCents: number, block: number): InvoiceLine[] {
  const lines: InvoiceLine[] = [];
  for (const j of jobs) {
    const mins = billableMinutes(j.minutes, block);
    if (mins > 0) {
      lines.push({
        jobId: j.jobId,
        description: `${j.number} ${j.plate}: ${j.title} — labour`,
        qty: mins / 60, // exact hours, so qty × rate equals the amount; shown as h:mm
        unitCents: ratePerHourCents,
        amountCents: labourCents(j.minutes, ratePerHourCents, block),
        isLabour: true,
      });
    }
    for (const p of j.parts) {
      lines.push({
        jobId: j.jobId,
        description: `${j.number} ${j.plate}: ${p.name}`,
        qty: p.qty,
        unitCents: p.unitPriceCents,
        amountCents: Math.round(p.qty * p.unitPriceCents),
        isLabour: false,
      });
    }
  }
  return lines;
}

export function invoiceTotals(lines: InvoiceLine[], taxPercent: number) {
  const subtotalCents = lines.reduce((t, l) => t + l.amountCents, 0);
  const taxCents = Math.round((subtotalCents * taxPercent) / 100);
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}

// ---- availability ----

/** Hours of [from, to) covered by the intervals, counting overlapping intervals once. */
export function coveredHours(intervals: { start: number; end: number | null }[], from: number, to: number, now: number): number {
  const clipped = intervals
    .map((i) => ({ start: Math.max(i.start, from), end: Math.min(i.end ?? now, to) }))
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start);
  let total = 0;
  let curStart = -Infinity;
  let curEnd = -Infinity;
  for (const i of clipped) {
    if (i.start > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = i.start;
      curEnd = i.end;
    } else curEnd = Math.max(curEnd, i.end);
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return total / 3_600_000;
}
