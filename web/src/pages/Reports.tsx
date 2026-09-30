import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useLoadedMeta } from "../api/auth";
import { api, errorText } from "../api/client";
import { Kpi } from "../components/ui";
import { fmtMoney0, fmtNum } from "../lib/format";

interface Report {
  summary: { jobsDone: number; avgTurnaroundHours: number | null; services: number; clientDefects: number };
  technicians: { technician: string; labourHours: number; jobs: number }[];
  clients: { client: string; bikes: number; jobsDone: number; downtimeHours: number; availabilityPct: number | null; invoicedCents: number }[];
  parts: { sku: string; name: string; qty: number; salesCents: number }[];
}

export function Reports() {
  const meta = useLoadedMeta();
  const [from, setFrom] = useState(new Date(Date.parse(`${meta.today}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10));
  const [to, setTo] = useState(meta.today);
  const query = `from=${from}&to=${to}`;
  const q = useQuery({ queryKey: ["reports", query], queryFn: () => api<Report>(`/reports?${query}`), enabled: from <= to });
  const csv = (table: string) => (
    <a className="btn btn-sm" href={`/api/reports?${query}&format=csv&table=${table}`} download>
      CSV
    </a>
  );
  return (
    <div className="wrap stack">
      <div className="row">
        <h1>Reports</h1>
        <span className="spacer" />
        <label className="inline">From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="inline">to <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      {q.isError && <div className="notice">{errorText(q.error)}</div>}
      {q.data && (
        <>
          <div className="kpis">
            <Kpi label="Jobs finished" value={fmtNum(q.data.summary.jobsDone)} sub={`${q.data.summary.services} services · ${q.data.summary.clientDefects} reported by clients`} />
            <Kpi label="Average turnaround" value={q.data.summary.avgTurnaroundHours === null ? "—" : `${q.data.summary.avgTurnaroundHours} h`} sub="from opened to finished" />
          </div>
          <section className="card table-wrap">
            <div className="row"><h2>Clients</h2><span className="spacer" />{csv("clients")}</div>
            <table>
              <thead><tr><th>Client</th><th className="num">Bikes</th><th className="num">Jobs</th><th className="num">Off-road hours</th><th className="num">Availability</th><th className="num">Invoiced</th></tr></thead>
              <tbody>
                {q.data.clients.map((c) => (
                  <tr key={c.client}>
                    <td>{c.client}</td><td className="num">{c.bikes}</td><td className="num">{c.jobsDone}</td><td className="num">{fmtNum(c.downtimeHours)}</td>
                    <td className={`num ${c.availabilityPct !== null && c.availabilityPct < 95 ? "bad" : ""}`}>{c.availabilityPct === null ? "—" : `${c.availabilityPct}%`}</td>
                    <td className="num">{fmtMoney0(c.invoicedCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted small">Availability is the share of bike-hours in the period when no job had the bike off the road.</p>
          </section>
          <div className="grid-2">
            <section className="card table-wrap">
              <div className="row"><h2>Technicians</h2><span className="spacer" />{csv("technicians")}</div>
              <table>
                <thead><tr><th>Technician</th><th className="num">Hours on the clock</th><th className="num">Jobs worked on</th></tr></thead>
                <tbody>{q.data.technicians.map((t) => <tr key={t.technician}><td>{t.technician}</td><td className="num">{t.labourHours}</td><td className="num">{t.jobs}</td></tr>)}</tbody>
              </table>
            </section>
            <section className="card table-wrap">
              <div className="row"><h2>Parts used</h2><span className="spacer" />{csv("parts")}</div>
              <table>
                <thead><tr><th>Part</th><th className="num">Qty</th><th className="num">Sales</th></tr></thead>
                <tbody>{q.data.parts.map((p) => <tr key={p.sku}><td>{p.sku} {p.name}</td><td className="num">{p.qty}</td><td className="num">{fmtMoney0(p.salesCents)}</td></tr>)}</tbody>
              </table>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
