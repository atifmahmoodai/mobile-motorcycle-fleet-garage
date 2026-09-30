import { useInfiniteQuery } from "@tanstack/react-query";
import { Navigate } from "react-router-dom";
import { isAdmin, useMe } from "../api/auth";
import { api, errorText } from "../api/client";
import { fmtDateTime } from "../lib/format";

interface AuditEntry {
  id: number;
  at: string;
  action: string;
  entity: string;
  entityId: string | null;
  details: Record<string, unknown>;
  ip: string | null;
  userName: string | null;
}

const LABELS: Record<string, string> = {
  "auth.login": "Signed in",
  "auth.login_failed": "Failed sign-in",
  "auth.password_changed": "Changed password",
  "client.create": "Added client",
  "client.update": "Edited client",
  "bike.create": "Added bike",
  "bike.update": "Edited bike",
  "job.create": "Opened job",
  "job.defect_reported": "Client reported a problem",
  "job.update": "Edited job",
  "job.complete": "Signed off job",
  "job.cancel": "Cancelled job",
  "labour.update": "Corrected time",
  "labour.delete": "Deleted time entry",
  "photo.delete": "Deleted photo",
  "part.create": "Added part",
  "part.update": "Edited part",
  "part.stock": "Stock movement",
  "invoice.issue": "Issued invoice",
  "invoice.paid": "Marked invoice paid",
  "invoice.void": "Voided invoice",
  "settings.update": "Changed settings",
  "user.create": "Added user",
  "user.update": "Edited user",
  "user.password_reset": "Reset password",
};

function summary(e: AuditEntry): string {
  const d = e.details as Record<string, unknown>;
  if (e.action === "bike.update") {
    const odo = d.odometer as { from: number; to: number } | undefined;
    return [d.plate, odo ? `odometer ${odo.from} → ${odo.to} km` : "", d.client ? "moved to another client" : "", d.retired ? "retired" : ""].filter(Boolean).join(" · ");
  }
  if (e.entity === "bike" && d.plate) return String(d.plate);
  if ((e.action === "job.create" || e.action === "job.defect_reported") && d.number) return `${d.number} · ${d.plate}`;
  if (e.action === "job.complete") return `odometer ${d.odometerKm} km${d.followUp ? " · follow-up repair opened" : ""}`;
  if (e.action === "job.cancel") return String(d.reason ?? "");
  if (e.action === "part.stock") return `${Number(d.qty) > 0 ? "+" : ""}${d.qty} (${d.reason})${d.note ? ` · ${d.note}` : ""}`;
  if (e.action === "invoice.issue") return `${d.number} · ${d.jobs} job(s)`;
  if (e.entity === "client" && d.name) return String(d.name);
  if (e.entity === "part" && d.sku) return String(d.sku);
  if (e.action === "user.create") return `${d.email} (${d.role})`;
  return "";
}

/** Who did what, and when. */
export function AuditLog() {
  const me = useMe();
  const q = useInfiniteQuery({
    queryKey: ["audit"],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) => api<{ items: AuditEntry[]; nextBefore: number | null }>(`/audit${pageParam ? `?before=${pageParam}` : ""}`),
    getNextPageParam: (last) => last.nextBefore,
    enabled: isAdmin(me.data),
  });
  if (!isAdmin(me.data)) return <Navigate to="/" replace />;
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="wrap">
      <div className="page-head">
        <h1>Activity</h1>
      </div>
      {q.isError && <div className="notice">{errorText(q.error)}</div>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>What</th>
              <th>Details</th>
              <th>IP</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id}>
                <td>{fmtDateTime(e.at)}</td>
                <td>{e.userName ?? <span className="muted">System</span>}</td>
                <td>{LABELS[e.action] ?? e.action}</td>
                <td className="muted">{summary(e)}</td>
                <td className="muted small">{e.ip}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {q.hasNextPage && (
        <div>
          <button className="btn" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            {q.isFetchingNextPage ? "Loading…" : "Show older"}
          </button>
        </div>
      )}
    </div>
  );
}
