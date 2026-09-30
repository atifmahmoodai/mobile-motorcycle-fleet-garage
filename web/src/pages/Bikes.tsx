import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { can, useLoadedMeta, useMe } from "../api/auth";
import { api, ApiError, errorText } from "../api/client";
import { Modal, Status } from "../components/ui";
import { fmtDate, fmtNum } from "../lib/format";
import type { Bike } from "../../../shared/types";

export function dueText(b: Bike) {
  if (b.due.status === "overdue") return b.due.kmLeft <= 0 ? `${fmtNum(-b.due.kmLeft)} km over` : `${-b.due.daysLeft} days over`;
  return `${fmtNum(b.due.kmLeft)} km or ${fmtDate(b.due.dueDate)}`;
}

export function Bikes() {
  const role = useMe().data!.role;
  const meta = useLoadedMeta();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [adding, setAdding] = useState(false);
  const query = new URLSearchParams();
  for (const k of ["q", "clientId", "due", "retired"]) if (params.get(k)) query.set(k, params.get(k)!);
  const bikes = useQuery({ queryKey: ["bikes", query.toString()], queryFn: () => api<{ items: Bike[] }>(`/bikes?${query}`) });
  const set = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    setParams(p, { replace: true });
  };
  const items = bikes.data?.items ?? [];
  return (
    <div className="wrap stack">
      <div className="row">
        <h1>{role === "client" ? "Our fleet" : "Bikes"}</h1>
        <span className="spacer" />
        {can.manage(role) && <button className="btn btn-primary" onClick={() => setAdding(true)}>Add bike</button>}
      </div>
      {role === "client" && (
        <p className="muted">
          {items.filter((b) => !b.offRoad).length} of {items.length} bikes on the road · {items.filter((b) => b.due.status === "overdue").length} overdue a service. Open a bike to report a problem.
        </p>
      )}
      <form className="row filters" onSubmit={(e) => { e.preventDefault(); set("q", q.trim()); }}>
        {role !== "client" && (
          <select aria-label="Client" value={params.get("clientId") ?? ""} onChange={(e) => set("clientId", e.target.value)}>
            <option value="">All clients</option>
            {meta.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        <select aria-label="Show" value={params.get("due") ?? ""} onChange={(e) => set("due", e.target.value)}>
          <option value="">All bikes</option>
          <option value="attention">Due, overdue or off the road</option>
        </select>
        <input aria-label="Search" placeholder="Registration or model" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn">Search</button>
      </form>
      {bikes.isError && <div className="notice">{errorText(bikes.error)}</div>}
      <div className="card table-wrap">
        <table>
          <thead>
            <tr><th>Registration</th><th>Bike</th>{role !== "client" && <th>Client</th>}<th className="num">Odometer</th><th>Service</th><th>Next due</th><th>Now</th></tr>
          </thead>
          <tbody>
            {items.map((b) => (
              <tr key={b.id}>
                <td><Link to={`/bikes/${b.id}`} className="plate">{b.plate}</Link></td>
                <td>{b.make} {b.model} <span className="muted small">{b.year}</span></td>
                {role !== "client" && <td>{b.clientName}</td>}
                <td className="num">{fmtNum(b.odometerKm)} km</td>
                <td><Status value={b.due.status} /></td>
                <td className="small">{dueText(b)}</td>
                <td>{b.offRoad ? <Status value="off_road" /> : b.openJobs ? <span className="small">{b.openJobs} open job{b.openJobs > 1 ? "s" : ""}</span> : <span className="muted small">On the road</span>}</td>
              </tr>
            ))}
            {bikes.data && !items.length && <tr><td colSpan={7} className="muted">No bikes match.</td></tr>}
          </tbody>
        </table>
      </div>
      {adding && <BikeForm onClose={() => setAdding(false)} />}
    </div>
  );
}

export function BikeForm({ bike, onClose }: { bike?: Bike; onClose: () => void }) {
  const meta = useLoadedMeta();
  const qc = useQueryClient();
  const [f, setF] = useState({
    clientId: bike?.clientId ?? meta.clients[0]?.id ?? "",
    plate: bike?.plate ?? "",
    vin: bike?.vin ?? "",
    make: bike?.make ?? "Honda",
    model: bike?.model ?? "",
    year: String(bike?.year ?? new Date().getFullYear()),
    engineCc: String(bike?.engineCc ?? 125),
    odometerKm: String(bike?.odometerKm ?? 0),
    serviceIntervalKm: String(bike?.serviceIntervalKm ?? 4000),
    serviceIntervalDays: String(bike?.serviceIntervalDays ?? 180),
    lastServiceKm: String(bike?.lastServiceKm ?? 0),
    lastServiceDate: bike?.lastServiceDate ?? meta.today,
    notes: bike?.notes ?? "",
    retired: bike?.retired ?? false,
  });
  const [error, setError] = useState<ApiError | Error | null>(null);
  const num = ["year", "engineCc", "odometerKm", "serviceIntervalKm", "serviceIntervalDays", "lastServiceKm"] as const;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = { ...f };
    for (const k of num) body[k] = Number(f[k]);
    try {
      if (bike) await api(`/bikes/${bike.id}`, { method: "PUT", body: { ...body, version: bike.version } });
      else await api("/bikes", { method: "POST", body });
      await qc.invalidateQueries({ queryKey: ["bikes"] });
      await qc.invalidateQueries({ queryKey: ["bike"] });
      onClose();
    } catch (err) {
      setError(err as Error);
    }
  };
  const fe = (k: string) => (error instanceof ApiError ? error.details[k] : undefined);
  const field = (k: keyof typeof f, label: string, type = "text") => (
    <label>
      {label}
      <input type={type} inputMode={num.includes(k as (typeof num)[number]) ? "numeric" : undefined} value={String(f[k])} onChange={(e) => setF({ ...f, [k]: e.target.value })} aria-invalid={!!fe(k)} />
      {fe(k) && <div className="field-error">{fe(k)}</div>}
    </label>
  );
  return (
    <Modal title={bike ? `Edit ${bike.plate}` : "Add a bike"} onClose={onClose} wide>
      <form className="stack" onSubmit={submit}>
        <div className="grid-3">
          <label>
            Client
            <select value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value })}>
              {meta.clients.filter((c) => c.active || c.id === f.clientId).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          {field("plate", "Registration")}
          {field("vin", "VIN")}
          {field("make", "Make")}
          {field("model", "Model")}
          {field("year", "Year")}
          {field("engineCc", "Engine cc (0 for electric)")}
          {field("odometerKm", "Odometer km")}
          {field("serviceIntervalKm", "Service every km")}
          {field("serviceIntervalDays", "…or every days")}
          {field("lastServiceKm", "Last service at km")}
          {field("lastServiceDate", "Last service date", "date")}
        </div>
        <label>Notes<textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></label>
        {bike && <label className="check"><input type="checkbox" checked={f.retired} onChange={(e) => setF({ ...f, retired: e.target.checked })} /> Retired (sold or scrapped)</label>}
        {error && <div className="notice notice-bad">{errorText(error)}</div>}
        <div className="row"><span className="spacer" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary">Save</button></div>
      </form>
    </Modal>
  );
}
