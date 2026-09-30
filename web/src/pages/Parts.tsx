import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { can, useMe } from "../api/auth";
import { api, errorText } from "../api/client";
import { Modal, MoneyInput } from "../components/ui";
import { fmtMoney } from "../lib/format";
import type { Part } from "../../../shared/types";

export function Parts() {
  const role = useMe().data!.role;
  const manage = can.manage(role);
  const [q, setQ] = useState("");
  const [low, setLow] = useState(false);
  const [editing, setEditing] = useState<Part | "new" | null>(null);
  const [stock, setStock] = useState<Part | null>(null);
  const query = new URLSearchParams({ ...(q ? { q } : {}), ...(low ? { low: "1" } : {}), ...(manage ? { all: "1" } : {}) });
  const parts = useQuery({ queryKey: ["parts", query.toString()], queryFn: () => api<{ items: Part[] }>(`/parts?${query}`) });
  return (
    <div className="wrap stack">
      <div className="row">
        <h1>Parts</h1>
        <span className="spacer" />
        {manage && <button className="btn btn-primary" onClick={() => setEditing("new")}>Add part</button>}
      </div>
      <div className="row filters">
        <input aria-label="Search" placeholder="Part number or name" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="check"><input type="checkbox" checked={low} onChange={(e) => setLow(e.target.checked)} /> Low stock only</label>
      </div>
      {parts.isError && <div className="notice">{errorText(parts.error)}</div>}
      <div className="card table-wrap">
        <table>
          <thead>
            <tr><th>Part</th><th>Name</th><th className="num">In stock</th><th className="num">Reorder at</th><th className="num">Price</th>{manage && <th className="num">Cost</th>}{manage && <th />}</tr>
          </thead>
          <tbody>
            {parts.data?.items.map((p) => (
              <tr key={p.id} className={p.active ? "" : "muted"}>
                <td>{p.sku}</td>
                <td>{p.name}{!p.active && " (not used)"}</td>
                <td className={`num ${p.stockQty <= p.minQty ? "bad" : ""}`}>{p.stockQty} {p.unit === "each" ? "" : p.unit}</td>
                <td className="num">{p.minQty}</td>
                <td className="num">{fmtMoney(p.priceCents)}</td>
                {manage && <td className="num">{fmtMoney(p.costCents)}</td>}
                {manage && (
                  <td className="num">
                    <button className="btn btn-sm" onClick={() => setStock(p)}>Stock</button> <button className="btn btn-sm" onClick={() => setEditing(p)}>Edit</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && <PartForm part={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {stock && <StockForm part={stock} onClose={() => setStock(null)} />}
    </div>
  );
}

function PartForm({ part, onClose }: { part: Part | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ sku: part?.sku ?? "", name: part?.name ?? "", unit: part?.unit ?? "each", minQty: String(part?.minQty ?? 2), costCents: part?.costCents ?? 0, priceCents: part?.priceCents ?? 0, active: part?.active ?? true });
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api(part ? `/parts/${part.id}` : "/parts", { method: part ? "PUT" : "POST", body: { ...f, minQty: Number(f.minQty) } });
      await qc.invalidateQueries({ queryKey: ["parts"] });
      onClose();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <Modal title={part ? `Edit ${part.sku}` : "Add part"} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <div className="grid-2">
          <label>Part number<input required value={f.sku} onChange={(e) => setF({ ...f, sku: e.target.value })} /></label>
          <label>Unit<select value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value as Part["unit"] })}><option value="each">each</option><option value="litre">litre</option><option value="metre">metre</option></select></label>
        </div>
        <label>Name<input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <div className="grid-3">
          <MoneyInput label="Cost" cents={f.costCents} onChange={(c) => setF({ ...f, costCents: c })} />
          <MoneyInput label="Price" cents={f.priceCents} onChange={(c) => setF({ ...f, priceCents: c })} />
          <label>Reorder at<input inputMode="decimal" value={f.minQty} onChange={(e) => setF({ ...f, minQty: e.target.value })} /></label>
        </div>
        {f.priceCents < f.costCents && <div className="notice notice-warn">The price is below cost.</div>}
        <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> In use</label>
        {error && <div className="notice notice-bad">{error}</div>}
        <div className="row"><span className="spacer" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary">Save</button></div>
      </form>
    </Modal>
  );
}

function StockForm({ part, onClose }: { part: Part; onClose: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState("delivery");
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const moves = useQuery({ queryKey: ["moves", part.id], queryFn: () => api<{ items: { id: number; at: string; qty: number; reason: string; note: string; userName: string | null; jobNumber: string | null }[] }>(`/parts/${part.id}/moves`) });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api(`/parts/${part.id}/stock`, { method: "POST", body: { qty: Number(qty), reason, note } });
      await qc.invalidateQueries({ queryKey: ["parts"] });
      onClose();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <Modal title={`${part.sku} ${part.name}: ${part.stockQty} in stock`} onClose={onClose} wide>
      <form className="row" onSubmit={submit}>
        <select aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)}>
          <option value="delivery">Delivery in</option>
          <option value="return">Return to supplier</option>
          <option value="adjustment">Stock-take adjustment (+/−)</option>
        </select>
        <input aria-label="Quantity" required inputMode="decimal" placeholder="Qty" value={qty} onChange={(e) => setQty(e.target.value)} style={{ width: 90 }} />
        <input aria-label="Note" placeholder="Note, e.g. PO number" value={note} onChange={(e) => setNote(e.target.value)} className="grow" />
        <button className="btn btn-primary">Save</button>
      </form>
      {error && <div className="notice notice-bad">{error}</div>}
      <div className="table-wrap" style={{ maxHeight: 300, overflow: "auto" }}>
        <table>
          <tbody>
            {moves.data?.items.map((m) => (
              <tr key={m.id}>
                <td className="small">{new Date(m.at).toLocaleString()}</td>
                <td className={`num ${m.qty < 0 ? "bad" : "good"}`}>{m.qty > 0 ? "+" : ""}{m.qty}</td>
                <td>{m.reason}{m.jobNumber ? ` ${m.jobNumber}` : ""}</td>
                <td className="small">{m.note} {m.userName && <span className="muted">· {m.userName}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}
