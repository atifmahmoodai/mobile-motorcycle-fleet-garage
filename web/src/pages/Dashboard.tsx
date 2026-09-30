import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, errorText } from "../api/client";
import { Kpi } from "../components/ui";
import { fmtDateTime, fmtMinutes, fmtNum } from "../lib/format";
import type { Dashboard as D } from "../../../shared/types";

export function Dashboard() {
  const q = useQuery({ queryKey: ["dashboard"], queryFn: () => api<D>("/dashboard"), refetchInterval: 60_000 });
  if (q.isError) return <div className="wrap"><div className="notice">{errorText(q.error)}</div></div>;
  if (!q.data) return <div className="wrap muted">Loading…</div>;
  const d = q.data;
  const open = Object.values(d.jobsByStatus).reduce((a, b) => a + b, 0);
  const now = Date.now();
  return (
    <div className="wrap stack">
      <h1>Workshop today</h1>
      <div className="kpis">
        <Kpi label="Open jobs" value={fmtNum(open)} sub={<Link to="/jobs?assigned=none">{d.unassigned} unassigned</Link>} tone={d.unassigned ? "warn" : undefined} />
        <Kpi label="In progress" value={fmtNum(d.jobsByStatus.in_progress ?? 0)} sub={`${d.jobsByStatus.waiting_parts ?? 0} waiting for parts`} />
        <Kpi label="Bikes off the road" value={fmtNum(d.offRoadBikes.length)} tone={d.offRoadBikes.length ? "warn" : undefined} />
        <Kpi label="Services due" value={fmtNum(d.dueCounts.overdue)} sub={`overdue · ${d.dueCounts.dueSoon} due soon`} tone={d.dueCounts.overdue ? "warn" : undefined} />
        <Kpi label="Finished today" value={fmtNum(d.completedToday)} />
      </div>
      <div className="grid-2">
        <section className="card stack">
          <h2>Off the road</h2>
          {d.offRoadBikes.length ? (
            <div className="table-wrap"><table>
              <thead>
                <tr><th>Bike</th><th>Client</th><th>Job</th><th className="num">Down for</th></tr>
              </thead>
              <tbody>
                {d.offRoadBikes.map((b) => (
                  <tr key={b.bikeId}>
                    <td><Link to={`/bikes/${b.bikeId}`} className="plate">{b.plate}</Link></td>
                    <td>{b.clientName}</td>
                    <td><Link to={`/jobs/${b.jobId}`}>{b.jobNumber}</Link></td>
                    <td className="num">{fmtMinutes((now - Date.parse(b.since)) / 60_000)}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          ) : (
            <p className="muted">Every bike is on the road.</p>
          )}
        </section>
        <section className="card stack">
          <h2>Clocks running</h2>
          {d.runningTimers.length ? (
            <ul className="plain">
              {d.runningTimers.map((t) => (
                <li key={t.jobId + t.technicianName}>
                  <b>{t.technicianName}</b> on <Link to={`/jobs/${t.jobId}`}>{t.jobNumber}</Link> <span className="plate">{t.plate}</span>{" "}
                  <span className="muted small">since {fmtDateTime(t.startedAt)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Nobody is on the clock.</p>
          )}
          <h2>Low stock</h2>
          {d.lowStock.length ? (
            <ul className="plain">
              {d.lowStock.map((p) => (
                <li key={p.id}>
                  {p.sku} {p.name}: <b>{p.stockQty}</b> <span className="muted small">(reorder at {p.minQty})</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Stock is fine.</p>
          )}
          <Link to="/bikes?due=attention">Bikes needing attention →</Link>
        </section>
      </div>
    </div>
  );
}
