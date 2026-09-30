import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useLoadedMeta } from "../api/auth";
import { api, errorText } from "../api/client";
import { Modal, MoneyInput } from "../components/ui";
import { fmtMoney } from "../lib/format";
import type { Client } from "../../../shared/types";

export function Clients() {
  const meta = useLoadedMeta();
  const q = useQuery({ queryKey: ["clients"], queryFn: () => api<{ items: Client[] }>("/clients") });
  const [editing, setEditing] = useState<Client | "new" | null>(null);
  return (
    <div className="wrap stack">
      <div className="row">
        <h1>Clients</h1>
        <span className="spacer" />
        <button className="btn btn-primary" onClick={() => setEditing("new")}>Add client</button>
      </div>
      {q.isError && <div className="notice">{errorText(q.error)}</div>}
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Client</th><th>Contact</th><th className="num">Bikes</th><th className="num">Open jobs</th><th className="num">Labour rate</th><th /></tr></thead>
          <tbody>
            {q.data?.items.map((c) => (
              <tr key={c.id} className={c.active ? "" : "muted"}>
                <td><b>{c.name}</b>{!c.active && " (inactive)"}</td>
                <td className="small">{c.contactName}<br />{c.email} {c.phone}</td>
                <td className="num"><Link to={`/bikes?clientId=${c.id}`}>{c.bikeCount}</Link></td>
                <td className="num"><Link to={`/jobs?clientId=${c.id}`}>{c.openJobs}</Link></td>
                <td className="num">{c.labourRateCents === null ? <span className="muted">{fmtMoney(meta.settings.labourRateCents)} (default)</span> : fmtMoney(c.labourRateCents)}</td>
                <td className="num"><button className="btn btn-sm" onClick={() => setEditing(c)}>Edit</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">Client logins (so a fleet manager can see their bikes and report problems) are created under Settings › Users.</p>
      {editing && <ClientForm client={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function ClientForm({ client, onClose }: { client: Client | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    name: client?.name ?? "",
    contactName: client?.contactName ?? "",
    email: client?.email ?? "",
    phone: client?.phone ?? "",
    address: client?.address ?? "",
    ownRate: client?.labourRateCents !== null && client?.labourRateCents !== undefined,
    labourRateCents: client?.labourRateCents ?? 6000,
    active: client?.active ?? true,
  });
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = { name: f.name, contactName: f.contactName, email: f.email, phone: f.phone, address: f.address, active: f.active, labourRateCents: f.ownRate ? f.labourRateCents : null };
    try {
      await api(client ? `/clients/${client.id}` : "/clients", { method: client ? "PUT" : "POST", body });
      await qc.invalidateQueries({ queryKey: ["clients"] });
      await qc.invalidateQueries({ queryKey: ["meta"] });
      onClose();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <Modal title={client ? `Edit ${client.name}` : "Add client"} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label>Name<input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <div className="grid-2">
          <label>Contact<input value={f.contactName} onChange={(e) => setF({ ...f, contactName: e.target.value })} /></label>
          <label>Phone<input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
        </div>
        <label>Email<input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
        <label>Address (for invoices)<textarea rows={2} value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></label>
        <label className="check"><input type="checkbox" checked={f.ownRate} onChange={(e) => setF({ ...f, ownRate: e.target.checked })} /> Agreed labour rate for this client</label>
        {f.ownRate && <MoneyInput label="Labour rate per hour" cents={f.labourRateCents} onChange={(c) => setF({ ...f, labourRateCents: c })} />}
        <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active</label>
        {error && <div className="notice notice-bad">{error}</div>}
        <div className="row"><span className="spacer" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={f.ownRate && Number.isNaN(f.labourRateCents)}>Save</button></div>
      </form>
    </Modal>
  );
}
