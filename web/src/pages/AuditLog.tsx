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
  "vehicle.create": "Added vehicle",
  "vehicle.update": "Edited vehicle",
  "vehicle.cost": "Added vehicle cost",
  "customer.create": "Added customer",
  "customer.update": "Edited customer",
  "lead.create": "New lead",
  "lead.update": "Updated lead",
  "deal.create": "New deal",
  "deal.update": "Edited deal",
  "deal.submit": "Submitted deal",
  "deal.approve": "Approved deal",
  "deal.reject": "Sent deal back",
  "deal.close": "Closed deal (sold)",
  "deal.cancel": "Cancelled deal",
  "service.create": "New service order",
  "service.update": "Updated service order",
  "service.close": "Closed service order",
  "service.cancel": "Cancelled service order",
  "document.upload": "Uploaded file",
  "document.delete": "Deleted file",
  "branch.create": "Added branch",
  "branch.update": "Edited branch",
  "settings.update": "Changed settings",
  "user.create": "Added user",
  "user.update": "Edited user",
  "user.password_reset": "Reset password",
};

function summary(e: AuditEntry): string {
  const d = e.details;
  if (e.action === "deal.close") return `${d.number} · stock ${d.stockNo}`;
  if (e.action === "deal.reject" || e.action === "deal.cancel") return String(d.reason ?? "");
  if (e.action === "vehicle.update" && d.listPriceTo !== undefined) return `${d.stockNo}: list price ${Number(d.listPriceFrom) / 100} → ${Number(d.listPriceTo) / 100}`;
  if (e.entity === "vehicle" && d.stockNo) return String(d.stockNo);
  if (e.action === "vehicle.cost") return `${d.description}: ${Number(d.amountCents) / 100}`;
  if (e.action === "service.close") return `${d.number}${d.invoiceNo ? ` → ${d.invoiceNo}` : " → cost posted to vehicle"}`;
  if (e.entity === "document" || e.action.startsWith("document.")) return String(d.filename ?? "");
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
