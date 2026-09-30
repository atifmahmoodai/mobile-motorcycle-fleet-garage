import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { can, useLoadedMeta, useMe } from "../api/auth";
import { api, errorText } from "../api/client";
import { fmtDate, fmtMinutes, fmtMoney } from "../lib/format";
import type { InvoiceDetail } from "../../../shared/types";

/** A printable invoice. The navigation is left off so it prints cleanly. */
export function InvoicePage() {
  const { id = "" } = useParams();
  const role = useMe().data!.role;
  const meta = useLoadedMeta();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["invoice", id], queryFn: () => api<InvoiceDetail>(`/invoices/${id}`) });
  const [error, setError] = useState<string | null>(null);
  if (q.isError) return <div className="wrap"><div className="notice">{errorText(q.error)}</div></div>;
  if (!q.data) return <div className="wrap muted">Loading…</div>;
  const inv = q.data;
  const act = async (path: string, confirm: string) => {
    if (!window.confirm(confirm)) return;
    try {
      await api(`/invoices/${id}/${path}`, { method: "POST" });
      await qc.invalidateQueries({ queryKey: ["invoice", id] });
      await qc.invalidateQueries({ queryKey: ["invoices"] });
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <div className="wrap print-doc stack">
      <div className="row no-print">
        <Link to="/invoices">← Invoices</Link>
        <span className="spacer" />
        <button className="btn" onClick={() => window.print()}>Print</button>
        {can.manage(role) && inv.status === "issued" && (
          <>
            <button className="btn" onClick={() => act("paid", `Mark ${inv.number} as paid?`)}>Mark paid</button>
            <button className="btn btn-danger" onClick={() => act("void", `Void ${inv.number}? Its jobs can then be invoiced again.`)}>Void</button>
          </>
        )}
      </div>
      {error && <div className="notice notice-bad no-print">{error}</div>}
      {inv.status !== "issued" && <div className={`notice ${inv.status === "void" ? "notice-bad" : ""}`}>This invoice is {inv.status === "void" ? "VOID" : "paid"}.</div>}
      <div className="row doc-head">
        <div>
          <h1>{meta.settings.companyName}</h1>
          <p className="pre small">{meta.settings.companyAddress}</p>
        </div>
        <span className="spacer" />
        <div className="num">
          <h2>Invoice {inv.number}</h2>
          <p className="small">Issued {fmtDate(inv.issuedAt)}<br />Due {fmtDate(inv.dueDate)}</p>
        </div>
      </div>
      <p>
        <b>{inv.clientName}</b>
        <br />
        <span className="pre small">{inv.clientAddress}</span>
      </p>
      <p className="small">Work finished {fmtDate(inv.periodStart)} to {fmtDate(inv.periodEnd)}</p>
      <table className="doc-lines">
        <thead><tr><th>Description</th><th className="num">Qty</th><th className="num">Unit</th><th className="num">Amount</th></tr></thead>
        <tbody>
          {inv.lines.map((l, i) => (
            <tr key={i}>
              <td>{l.description}</td>
              <td className="num">{l.isLabour ? fmtMinutes(l.qty * 60) : l.qty}</td>
              <td className="num">{fmtMoney(l.unitCents)}{l.isLabour ? "/h" : ""}</td>
              <td className="num">{fmtMoney(l.amountCents)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr><td colSpan={3} className="num">Subtotal</td><td className="num">{fmtMoney(inv.subtotalCents)}</td></tr>
          <tr><td colSpan={3} className="num">Tax {inv.taxPercent}%</td><td className="num">{fmtMoney(inv.taxCents)}</td></tr>
          <tr className="total"><td colSpan={3} className="num">Total</td><td className="num">{fmtMoney(inv.totalCents)}</td></tr>
        </tfoot>
      </table>
    </div>
  );
}
