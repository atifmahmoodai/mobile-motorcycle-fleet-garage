// Shapes the API returns. Money is integer cents; timestamps are ISO strings; dates are YYYY-MM-DD.
import type { CheckItem, ServiceDue } from "./fleet";
import type { JobKind, JobStatus, Priority, Role } from "./schemas";

export type { CheckItem, ServiceDue };

export interface Settings {
  companyName: string;
  companyAddress: string;
  currency: string;
  locale: string;
  taxPercent: number;
  labourRateCents: number;
  labourBlockMinutes: number;
  paymentTermsDays: number;
  dueSoonKm: number;
  dueSoonDays: number;
  serviceChecklist: { key: string; label: string; safety: boolean }[];
  inspectionChecklist: { key: string; label: string; safety: boolean }[];
}

export interface UserSummary {
  id: string;
  name: string;
  role: Role;
  clientId: string | null;
}

export interface Meta {
  settings: Settings;
  users: UserSummary[];
  clients: { id: string; name: string; active: boolean }[];
  today: string;
  timeZone: string;
}

export interface Client {
  id: string;
  name: string;
  contactName: string;
  email: string | null;
  phone: string;
  address: string;
  labourRateCents: number | null;
  active: boolean;
  bikeCount: number;
  openJobs: number;
}

export interface Bike {
  id: string;
  clientId: string;
  clientName: string;
  plate: string;
  vin: string;
  make: string;
  model: string;
  year: number;
  engineCc: number;
  odometerKm: number;
  serviceIntervalKm: number;
  serviceIntervalDays: number;
  lastServiceKm: number;
  lastServiceDate: string;
  notes: string;
  retired: boolean;
  version: number;
  /** Open jobs on the bike, and whether any of them keeps it off the road. */
  openJobs: number;
  offRoad: boolean;
  due: ServiceDue;
}

export interface Job {
  id: string;
  number: string;
  bikeId: string;
  plate: string;
  bikeName: string;
  clientId: string;
  clientName: string;
  kind: JobKind;
  priority: Priority;
  status: JobStatus;
  title: string;
  description: string;
  source: "workshop" | "client";
  offRoad: boolean;
  scheduledFor: string | null;
  assignedTo: string | null;
  assignedName: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  invoiceNumber: string | null;
  version: number;
}

export interface LabourEntry {
  id: string;
  technicianId: string;
  technicianName: string;
  startedAt: string;
  endedAt: string | null;
  minutes: number | null;
}

export interface JobPart {
  id: string;
  partId: string;
  sku: string;
  name: string;
  unit: string;
  qty: number;
  unitPriceCents: number;
  /** Only for admins and managers. */
  unitCostCents?: number;
}

export interface JobNote {
  id: string;
  at: string;
  author: string;
  text: string;
}

export interface PhotoMeta {
  id: string;
  name: string;
  size: number;
  addedAt: string;
}

export interface JobDetail extends Job {
  odometerKm: number | null;
  summary: string;
  checklist: CheckItem[];
  labour: LabourEntry[];
  parts: JobPart[];
  notes: JobNote[];
  photos: PhotoMeta[];
  labourMinutes: number;
  /** A running timer by the current user on this job. */
  myTimerStartedAt: string | null;
  followUpOf: string | null;
}

export interface Part {
  id: string;
  sku: string;
  name: string;
  unit: "each" | "litre" | "metre";
  stockQty: number;
  minQty: number;
  priceCents: number;
  costCents?: number;
  active: boolean;
}

export interface InvoiceSummary {
  id: string;
  number: string;
  clientId: string;
  clientName: string;
  periodStart: string;
  periodEnd: string;
  issuedAt: string;
  dueDate: string;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  status: "issued" | "paid" | "void";
}

export interface InvoiceDetail extends InvoiceSummary {
  taxPercent: number;
  clientAddress: string;
  lines: { description: string; qty: number; unitCents: number; amountCents: number; isLabour: boolean }[];
}

export interface Dashboard {
  jobsByStatus: Record<string, number>;
  unassigned: number;
  offRoadBikes: { bikeId: string; plate: string; clientName: string; since: string; jobNumber: string; jobId: string }[];
  dueCounts: { overdue: number; dueSoon: number };
  runningTimers: { technicianName: string; jobId: string; jobNumber: string; plate: string; startedAt: string }[];
  lowStock: { id: string; sku: string; name: string; stockQty: number; minQty: number }[];
  completedToday: number;
}

export interface ReportRow {
  [k: string]: string | number | null;
}
