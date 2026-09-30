import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { can, useMe } from "../api/auth";
import { api, errorText } from "../api/client";
import { Modal, Status } from "../components/ui";
import { fmtDate, fmtNum, KIND_LABEL } from "../lib/format";
import type { Bike, Job } from "../../../shared/types";
import { BikeForm, dueText } from "./Bikes";
import { NewJob } from "./Jobs";

export function BikePage() {
  const { id = "" } = useParams();
  const role = useMe().data!.role;
  const q = useQuery({ queryKey: ["bike", id], queryFn: () => api<{ bike: Bike; jobs: Job[] }>(`/bikes/${id}`) });
  const [editing, setEditing] = useState(false);
  const [newJob, setNewJob] = useState(false);
  const [reporting, setReporting] = useState(false);
  if (q.isError) return <div className="wrap"><div className="notice">{errorText(q.error)}</div></div>;
  if (!q.data) return <div className="wrap muted">Loading…</div>;
  const { bike, jobs } = q.data;
  return (
    <div className="wrap stack">
      <Link to="/bikes" className="small">← {role === "client" ? "Our fleet" : "Bikes"}</Link>
      <div className="row">
        <h1><span className="plate big">{bike.plate}</span> {bike.make} {bike.model}</h1>
        <span className="spacer" />
        {bike.retired && <span className="badge">Retired</span>}
        {bike.offRoad && <Status value="off_road" />}
        <Status value={bike.due.status} />
      </div>
      <div className="row">
        {!bike.retired && <button className="btn btn-primary" onClick={() => setReporting(true)}>Report a problem</button>}
        {can.manage(role) && !bike.retired && <button className="btn" onClick={() => setNewJob(true)}>New job</button>}
        {can.manage(role) && <button className="btn" onClick={() => setEditing(true)}>Edit bike</button>}
      </div>
      <div className="kpis">
        <div className="kpi"><div className="kpi-label">Odometer</div><div className="kpi-value">{fmtNum(bike.odometerKm)} km</div></div>
        <div className="kpi"><div className="kpi-label">Next service</div><div className="kpi-value small-value">{dueText(bike)}</div><div className="kpi-sub">every {fmtNum(bike.serviceIntervalKm)} km or {bike.serviceIntervalDays} days</div></div>
        <div className="kpi"><div className="kpi-label">Last service</div><div className="kpi-value small-value">{fmtDate(bike.lastServiceDate)}</div><div className="kpi-sub">at {fmtNum(bike.lastServiceKm)} km</div></div>
        <div className="kpi"><div className="kpi-label">Client</div><div className="kpi-value small-value">{bike.clientName}</div><div className="kpi-sub">{bike.year} · {bike.engineCc ? `${bike.engineCc}cc` : "electric"} · {bike.vin || "no VIN"}</div></div>
      </div>
      {bike.notes && <p className="pre card">{bike.notes}</p>}
      <section className="card table-wrap">
        <h2>History</h2>
        <table>
          <thead><tr><th>Job</th><th>What</th><th>Status</th><th>Opened</th><th>Finished</th></tr></thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td><Link to={`/jobs/${j.id}`}>{j.number}</Link></td>
                <td>{j.title} <span className="muted small">{KIND_LABEL[j.kind]}</span></td>
                <td><Status value={j.status} /></td>
                <td>{fmtDate(j.createdAt)}</td>
                <td>{fmtDate(j.completedAt)}</td>
              </tr>
            ))}
            {!jobs.length && <tr><td colSpan={5} className="muted">No jobs yet.</td></tr>}
          </tbody>
        </table>
      </section>
      {editing && <BikeForm bike={bike} onClose={() => setEditing(false)} />}
      {newJob && <NewJob bike={bike} onClose={() => setNewJob(false)} />}
      {reporting && <ReportProblem bike={bike} onClose={() => setReporting(false)} />}
    </div>
  );
}

function ReportProblem({ bike, onClose }: { bike: Bike; onClose: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [offRoad, setOffRoad] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<{ id: string; number: string }>("/defects", { method: "POST", body: { bikeId: bike.id, title, description, offRoad } });
      await qc.invalidateQueries({ queryKey: ["bike", bike.id] });
      await qc.invalidateQueries({ queryKey: ["bikes"] });
      nav(`/jobs/${r.id}`);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Modal title={`Report a problem with ${bike.plate}`} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label>What's wrong?<input required minLength={3} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Front brake feels spongy" /></label>
        <label>Details<textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="When it happens, where the bike is now…" /></label>
        <label className="check"><input type="checkbox" checked={offRoad} onChange={(e) => setOffRoad(e.target.checked)} /> It isn't safe to ride — take it off the road</label>
        {error && <div className="notice notice-bad">{error}</div>}
        <div className="row"><span className="spacer" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy}>Send to the workshop</button></div>
      </form>
    </Modal>
  );
}
