import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { can, useLoadedMeta, useMe } from "../api/auth";
import { api, errorText } from "../api/client";
import { Modal, Status } from "../components/ui";
import { fmtDate, fmtMinutes, fmtMoney } from "../lib/format";
import type { InvoiceLine } from "../../../shared/fleet";
import type { InvoiceSummary } from "../../../shared/types";

export function Invoices() {
  const role = useMe().data!.role;
  const q = useQuery({ queryKey: ["invoices"], queryFn: () => api<{ items: InvoiceSummary[] }>("/invoices") });
  const [running, setRunning] = useState(false);
  return (
    <div className="wrap stack">
      <div className="row">
        <h1>Invoices</h1>
        <span className="spacer" />
        {can.manage(role) && <button className="btn btn-primary" onClick={() => setRunning(true)}>Invoice a client</button>}
      </div>
      {q.isError && <div className="notice">{errorText(q.error)}</div>}
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Invoice</th>{role !== "client" && <th>Client</th>}<th>Period</th><th>Issued</th><th>Due</th><th className="num">Total</th><th>Status</th></tr></thead>
          <tbody>
            {q.data?.items.map((i) => (
              <tr key={i.id}>
                <td><Link to={`/invoices/${i.id}`}>{i.number}</Link></td>
                {role !== "client" && <td>{i.clientName}</td>}
                <td className="small">{fmtDate(i.periodStart)} – {fmtDate(i.periodEnd)}</td>
                <td>{fmtDate(i.issuedAt)}</td>
                <td>{fmtDate(i.dueDate)}</td>
                <td className="num">{fmtMoney(i.totalCents)}</td>
                <td><Status value={i.status} /></td>
              </tr>
            ))}
            {q.data && !q.data.items.length && <tr><td colSpan={7} className="muted">No invoices yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {running && <InvoiceRun onClose={() => setRunning(false)} />}
    </div>
  );
}

interface Preview {
  jobs: { id: string; number: string; plate: string; title: string; minutes: number }[];
  lines: InvoiceLine[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}

function InvoiceRun({ onClose }: { onClose: () => void }) {
  const meta = useLoadedMeta();
  const nav = useNavigate();
  const qc = useQueryClient();
  const firstOfMonth = `${meta.today.slice(0, 8)}01`;
  const lastMonthStart = new Date(Date.UTC(+meta.today.slice(0, 4), +meta.today.slice(5, 7) - 2, 1)).toISOString().slice(0, 10);
  const lastMonthEnd = new Date(Date.parse(`${firstOfMonth}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const [clientId, setClientId] = useState(meta.clients.find((c) => c.active)?.id ?? "");
  const [from, setFrom] = useState(lastMonthStart);
  const [to, setTo] = useState(lastMonthEnd);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const body = { clientId, periodStart: from, periodEnd: to };
  const load = async () => {
    setError(null);
    try {
      setPreview(await api<Preview>("/invoices/preview", { method: "POST", body }));
    } catch (e) {
      setError(errorText(e));
    }
  };
  const issue = async () => {
    setBusy(true);
    try {
      const r = await api<{ id: string }>("/invoices", { method: "POST", body });
      await qc.invalidateQueries({ queryKey: ["invoices"] });
      nav(`/invoices/${r.id}`);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Modal title="Invoice a client" onClose={onClose} wide>
      <div className="grid-3">
        <label>Client<select value={clientId} onChange={(e) => { setClientId(e.target.value); setPreview(null); }}>{meta.clients.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label>Work finished from<input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPreview(null); }} /></label>
        <label>to<input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPreview(null); }} /></label>
      </div>
      <div className="row"><button className="btn" onClick={load}>Show what would be billed</button></div>
      {error && <div className="notice notice-bad">{error}</div>}
      {preview && (
        preview.jobs.length ? (
          <>
            <p className="muted small">{preview.jobs.length} finished job{preview.jobs.length > 1 ? "s" : ""} not yet invoiced · labour {fmtMinutes(preview.jobs.reduce((t, j) => t + j.minutes, 0))} worked, billed in {meta.settings.labourBlockMinutes}-minute blocks.</p>
            <div className="table-wrap" style={{ maxHeight: 320, overflow: "auto" }}>
              <table>
                <tbody>
                  {preview.lines.map((l, i) => (
                    <tr key={i}><td className="small">{l.description}</td><td className="num">{l.isLabour ? fmtMinutes(l.qty * 60) : l.qty}</td><td className="num">{fmtMoney(l.amountCents)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="num">Subtotal {fmtMoney(preview.subtotalCents)} · Tax {fmtMoney(preview.taxCents)} · <b>Total {fmtMoney(preview.totalCents)}</b></p>
            <div className="row"><span className="spacer" /><button className="btn btn-primary" disabled={busy} onClick={issue}>Issue invoice</button></div>
          </>
        ) : (
          <p className="muted">Nothing to invoice for that client and period.</p>
        )
      )}
    </Modal>
  );
}
