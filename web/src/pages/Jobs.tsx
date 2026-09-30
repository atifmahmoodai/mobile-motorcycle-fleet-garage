import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { can, useLoadedMeta, useMe } from "../api/auth";
import { api, ApiError, errorText } from "../api/client";
import { Modal, Status } from "../components/ui";
import { fmtDate, KIND_LABEL } from "../lib/format";
import { JOB_KINDS, type JobKind } from "../../../shared/schemas";
import type { Bike, Job } from "../../../shared/types";

export function Jobs() {
  const role = useMe().data!.role;
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "open";
  const assigned = params.get("assigned") ?? "";
  const [q, setQ] = useState(params.get("q") ?? "");
  const [creating, setCreating] = useState(false);
  const query = new URLSearchParams({ status, ...(assigned ? { assigned } : {}), ...(params.get("q") ? { q: params.get("q")! } : {}) });
  const jobs = useQuery({ queryKey: ["jobs", query.toString()], queryFn: () => api<{ items: Job[] }>(`/jobs?${query}`) });
  const update = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    setParams(p, { replace: true });
  };
  return (
    <div className="wrap stack">
      <div className="row">
        <h1>{role === "client" ? "Our jobs" : "Jobs"}</h1>
        <span className="spacer" />
        {can.manage(role) && (
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            New job
          </button>
        )}
      </div>
      <form
        className="row filters"
        onSubmit={(e) => {
          e.preventDefault();
          update("q", q.trim());
        }}
      >
        <select aria-label="Status" value={status} onChange={(e) => update("status", e.target.value)}>
          <option value="open">Open</option>
          <option value="done">Done</option>
          <option value="cancelled">Cancelled</option>
          <option value="all">All</option>
        </select>
        {role !== "client" && (
          <select aria-label="Assigned" value={assigned} onChange={(e) => update("assigned", e.target.value)}>
            <option value="">Anyone</option>
            <option value="me">Mine</option>
            <option value="none">Unassigned</option>
          </select>
        )}
        <input aria-label="Search" placeholder="Job number, registration or title" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn">Search</button>
      </form>
      {jobs.isError && <div className="notice">{errorText(jobs.error)}</div>}
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>Job</th><th>Bike</th><th>What</th><th>Client</th><th>Assigned</th><th>Status</th><th>Opened</th>
            </tr>
          </thead>
          <tbody>
            {jobs.data?.items.map((j) => (
              <tr key={j.id}>
                <td><Link to={`/jobs/${j.id}`}>{j.number}</Link></td>
                <td><span className="plate">{j.plate}</span></td>
                <td>
                  {j.title} <span className="muted small">{KIND_LABEL[j.kind]}</span> {j.priority === "urgent" && <Status value="urgent" />} {j.offRoad && <Status value="off_road" />}
                </td>
                <td>{j.clientName}</td>
                <td>{j.assignedName ?? <span className="muted">—</span>}</td>
                <td><Status value={j.status} /></td>
                <td>{fmtDate(j.createdAt)}</td>
              </tr>
            ))}
            {jobs.data && !jobs.data.items.length && (
              <tr><td colSpan={7} className="muted">No jobs match.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {creating && <NewJob onClose={() => setCreating(false)} />}
    </div>
  );
}

export function NewJob({ onClose, bike: fixedBike }: { onClose: () => void; bike?: Bike }) {
  const meta = useLoadedMeta();
  const nav = useNavigate();
  const qc = useQueryClient();
  const bikes = useQuery({ queryKey: ["bikes", "all"], queryFn: () => api<{ items: Bike[] }>("/bikes"), enabled: !fixedBike });
  const [bikeId, setBikeId] = useState(fixedBike?.id ?? "");
  const [kind, setKind] = useState<JobKind>("service");
  const [title, setTitle] = useState("Scheduled service");
  const [description, setDescription] = useState("");
  const [offRoad, setOffRoad] = useState(false);
  const [priority, setPriority] = useState("normal");
  const [scheduledFor, setScheduledFor] = useState("");
  const [assignedTo, setAssignedTo] = useState("");
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [busy, setBusy] = useState(false);
  const techs = meta.users.filter((u) => u.role !== "client");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<{ id: string }>("/jobs", {
        method: "POST",
        body: { bikeId, kind, title, description, offRoad, priority, scheduledFor: scheduledFor || null, assignedTo: assignedTo || null },
      });
      await qc.invalidateQueries({ queryKey: ["jobs"] });
      nav(`/jobs/${r.id}`);
    } catch (err) {
      setError(err as Error);
      setBusy(false);
    }
  };
  const fieldError = (k: string) => (error instanceof ApiError ? error.details[k] : undefined);
  return (
    <Modal title={fixedBike ? `New job for ${fixedBike.plate}` : "New job"} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {!fixedBike && (
          <label>
            Bike
            <select required value={bikeId} onChange={(e) => setBikeId(e.target.value)}>
              <option value="">Choose…</option>
              {bikes.data?.items.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.plate} · {b.make} {b.model} · {b.clientName}
                </option>
              ))}
            </select>
            {fieldError("bikeId") && <div className="field-error">{fieldError("bikeId")}</div>}
          </label>
        )}
        <div className="grid-2">
          <label>
            Type
            <select
              value={kind}
              onChange={(e) => {
                const k = e.target.value as JobKind;
                setKind(k);
                if (k === "service") setTitle("Scheduled service");
                else if (k === "inspection") setTitle("Safety inspection");
                else if (title === "Scheduled service" || title === "Safety inspection") setTitle("");
              }}
            >
              {JOB_KINDS.map((k) => (
                <option key={k} value={k}>{KIND_LABEL[k]}</option>
              ))}
            </select>
          </label>
          <label>
            Priority
            <select value={priority} onChange={(e) => setPriority(e.target.value)}>
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="urgent">Urgent</option>
            </select>
          </label>
        </div>
        <label>
          Title
          <input required minLength={3} value={title} onChange={(e) => setTitle(e.target.value)} />
          {fieldError("title") && <div className="field-error">{fieldError("title")}</div>}
        </label>
        <label>
          Details
          <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <div className="grid-2">
          <label>
            Booked for
            <input type="date" value={scheduledFor} onChange={(e) => setScheduledFor(e.target.value)} />
          </label>
          <label>
            Technician
            <select value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}>
              <option value="">Unassigned</option>
              {techs.map((u) => (
                <option key={u.id} value={u.id}>{u.name}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={offRoad} onChange={(e) => setOffRoad(e.target.checked)} /> The bike must not be ridden until this is done
        </label>
        {error && <div className="notice notice-bad">{errorText(error)}</div>}
        <div className="row">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>Create job</button>
        </div>
      </form>
    </Modal>
  );
}
