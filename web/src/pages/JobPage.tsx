import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { can, useLoadedMeta, useMe } from "../api/auth";
import { api, errorText } from "../api/client";
import { Modal, Status } from "../components/ui";
import { fmtDate, fmtDateTime, fmtMinutes, fmtMoney, fromLocalInput, KIND_LABEL, toLocalInput } from "../lib/format";
import type { CheckResult } from "../../../shared/schemas";
import type { JobDetail, LabourEntry, Part } from "../../../shared/types";

export function JobPage() {
  const { id = "" } = useParams();
  const role = useMe().data!.role;
  const manage = can.manage(role);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["job", id], queryFn: () => api<JobDetail>(`/jobs/${id}`) });
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [labour, setLabour] = useState<LabourEntry | null>(null);
  const [odometer, setOdometer] = useState("");
  const [summary, setSummary] = useState("");
  const [note, setNote] = useState("");
  const [partId, setPartId] = useState("");
  const [qty, setQty] = useState("1");
  const [followUp, setFollowUp] = useState<string | null>(null);
  const parts = useQuery({ queryKey: ["parts"], queryFn: () => api<{ items: Part[] }>("/parts"), enabled: manage });

  if (q.isError) return <div className="wrap"><div className="notice">{errorText(q.error)}</div></div>;
  if (!q.data) return <div className="wrap muted">Loading…</div>;
  const job = q.data;
  const open = job.status !== "done" && job.status !== "cancelled";

  const act = async (path: string, body?: unknown, method = "POST") => {
    setError(null);
    try {
      const r = await api<JobDetail & { followUpId?: string | null }>(path, { method, body });
      if (r && "id" in r) qc.setQueryData(["job", id], r);
      if (r?.followUpId) setFollowUp(r.followUpId);
      void qc.invalidateQueries({ queryKey: ["jobs"] });
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    }
  };
  const check = (key: string, result: CheckResult | null, note: string) => act(`/jobs/${id}/checklist`, { key, result, note });

  return (
    <div className="wrap stack">
      <Link to="/jobs" className="small">← Jobs</Link>
      <div className="row">
        <h1>
          {job.number}: {job.title}
        </h1>
        <span className="spacer" />
        {job.priority === "urgent" && <Status value="urgent" />}
        {job.offRoad && open && <Status value="off_road" />}
        <Status value={job.status} />
      </div>
      <p className="muted">
        {KIND_LABEL[job.kind]} · <Link to={`/bikes/${job.bikeId}`} className="plate">{job.plate}</Link> {job.bikeName} · {job.clientName} · opened {fmtDateTime(job.createdAt)}
        {job.source === "client" ? " by the client" : ""}
        {job.assignedName ? ` · ${job.assignedName}` : ""}
        {job.scheduledFor ? ` · booked for ${fmtDate(job.scheduledFor)}` : ""}
        {job.invoiceNumber ? ` · invoiced on ${job.invoiceNumber}` : ""}
      </p>
      {job.followUpOf && <p className="small">Follow-up to <Link to={`/jobs/${job.followUpOf}`}>an earlier job</Link> with failed safety checks.</p>}
      {followUp && (
        <div className="notice notice-warn">
          Safety checks failed, so the bike stays off the road under a new urgent job: <Link to={`/jobs/${followUp}`}>open it</Link>.
        </div>
      )}
      {error && <div className="notice notice-bad">{error}</div>}
      {job.description && <p className="pre card">{job.description}</p>}
      {job.summary && (
        <div className="card">
          <h2>Work done</h2>
          <p className="pre">{job.summary}</p>
        </div>
      )}

      {manage && open && (
        <div className="row">
          <button className="btn" onClick={() => setEditing(true)}>Edit</button>
          <button className="btn" onClick={() => act(`/jobs/${id}/timer`, { action: job.myTimerStartedAt ? "stop" : "start" })}>
            {job.myTimerStartedAt ? "Stop my clock" : "Start my clock"}
          </button>
          {job.status !== "waiting_parts" && <button className="btn" onClick={() => act(`/jobs/${id}/waiting-parts`)}>Waiting for parts</button>}
          <span className="spacer" />
          <button
            className="btn btn-danger"
            onClick={() => {
              const reason = window.prompt("Why is this job being cancelled?");
              if (reason) void act(`/jobs/${id}/cancel`, { reason });
            }}
          >
            Cancel job
          </button>
        </div>
      )}

      <div className="grid-2">
        {job.checklist.length > 0 && (
          <section className="card stack">
            <h2>Checklist</h2>
            <div className="table-wrap"><table>
              <tbody>
                {job.checklist.map((i) => (
                  <tr key={i.key} className={i.result === "fail" ? "row-bad" : ""}>
                    <td>
                      {i.label}
                      {i.safety && <span className="muted small"> · safety</span>}
                      {i.note && <div className="small">{i.note}</div>}
                    </td>
                    <td className="num">
                      {manage && open ? (
                        <select
                          aria-label={i.label}
                          value={i.result ?? ""}
                          onChange={(e) => {
                            const v = (e.target.value || null) as CheckResult | null;
                            const n = v === "fail" ? (window.prompt(`What is wrong with ${i.label}?`, i.note) ?? "") : i.note;
                            void check(i.key, v, n);
                          }}
                        >
                          <option value="">—</option>
                          <option value="pass">Pass</option>
                          <option value="fail">Fail</option>
                          <option value="na">N/A</option>
                        </select>
                      ) : (
                        <span className={i.result === "fail" ? "bad" : ""}>{i.result === "pass" ? "Pass" : i.result === "fail" ? "Fail" : i.result === "na" ? "N/A" : "—"}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </section>
        )}

        <section className="card stack">
          <h2>Time</h2>
          <div className="table-wrap"><table>
            <tbody>
              {job.labour.map((l) => (
                <tr key={l.id}>
                  <td>{l.technicianName}</td>
                  <td>{fmtDateTime(l.startedAt)}</td>
                  <td className="num">{l.endedAt ? fmtMinutes(l.minutes) : <span className="badge badge-warn">Running</span>}</td>
                  {manage && (
                    <td className="num">
                      {l.endedAt && !job.invoiceNumber && job.status !== "cancelled" && <button className="btn btn-sm" onClick={() => setLabour(l)}>Correct</button>}
                    </td>
                  )}
                </tr>
              ))}
              {!job.labour.length && <tr><td className="muted">No time yet.</td></tr>}
            </tbody>
          </table></div>
          <p className="small">Total {fmtMinutes(job.labourMinutes)}</p>

          <h2>Parts</h2>
          <div className="table-wrap"><table>
            <tbody>
              {job.parts.map((p) => (
                <tr key={p.id}>
                  <td>{p.qty} × {p.sku} {p.name}</td>
                  <td className="num">{fmtMoney(p.qty * p.unitPriceCents)}</td>
                  {manage && open && (
                    <td className="num">
                      <button className="btn btn-sm" onClick={() => act(`/jobs/${id}/parts/${p.id}`, undefined, "DELETE")} aria-label={`Remove ${p.sku}`}>✕</button>
                    </td>
                  )}
                </tr>
              ))}
              {!job.parts.length && <tr><td className="muted">No parts.</td></tr>}
            </tbody>
          </table></div>
          {manage && open && (
            <div className="row">
              <select aria-label="Part" value={partId} onChange={(e) => setPartId(e.target.value)} className="grow">
                <option value="">Add a part…</option>
                {parts.data?.items.map((p) => (
                  <option key={p.id} value={p.id} disabled={p.stockQty <= 0}>
                    {p.sku} {p.name} ({p.stockQty} in stock)
                  </option>
                ))}
              </select>
              <input aria-label="Quantity" value={qty} onChange={(e) => setQty(e.target.value)} style={{ width: 70 }} inputMode="decimal" />
              <button className="btn" disabled={!partId} onClick={async () => (await act(`/jobs/${id}/parts`, { partId, qty: Number(qty) })) && setPartId("")}>Add</button>
            </div>
          )}
        </section>
      </div>

      {(job.notes.length > 0 || can.work(role)) && (
        <section className="card stack">
          <h2>Workshop notes</h2>
          {job.notes.map((n) => (
            <p key={n.id} className="note">
              <span className="muted small">{n.author} · {fmtDateTime(n.at)}</span>
              <br />
              {n.text}
            </p>
          ))}
          {can.work(role) && (
            <div className="row">
              <input aria-label="Note" className="grow" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note (not shown to the client)" />
              <button className="btn" disabled={!note.trim()} onClick={async () => (await act(`/jobs/${id}/notes`, { text: note })) && setNote("")}>Save</button>
            </div>
          )}
        </section>
      )}

      {job.photos.length > 0 && (
        <section className="card stack">
          <h2>Photos</h2>
          <div className="photos">
            {job.photos.map((p) => (
              <a key={p.id} href={`/api/photos/${p.id}`} target="_blank" rel="noreferrer">
                <img src={`/api/photos/${p.id}`} alt={p.name} loading="lazy" />
              </a>
            ))}
          </div>
        </section>
      )}

      {manage && open && (
        <section className="card stack">
          <h2>Sign off</h2>
          <div className="grid-2">
            <label>
              Odometer (km)
              <input inputMode="numeric" value={odometer} onChange={(e) => setOdometer(e.target.value.replace(/\D/g, ""))} />
            </label>
            <label>
              Work done (the client sees this)
              <input value={summary} onChange={(e) => setSummary(e.target.value)} />
            </label>
          </div>
          <div className="row">
            <span className="spacer" />
            <button className="btn btn-primary" disabled={!odometer} onClick={() => act(`/jobs/${id}/complete`, { odometerKm: Number(odometer), summary })}>
              Sign off job
            </button>
          </div>
        </section>
      )}

      {editing && <EditJob job={job} onClose={() => setEditing(false)} onSaved={(j) => { qc.setQueryData(["job", id], j); setEditing(false); }} />}
      {labour && (
        <EditLabour
          entry={labour}
          onClose={() => setLabour(null)}
          onSave={async (startedAt, endedAt) => (await act(`/jobs/${id}/labour/${labour.id}`, { startedAt, endedAt }, "PUT")) && setLabour(null)}
          onDelete={async () => (await act(`/jobs/${id}/labour/${labour.id}`, undefined, "DELETE")) && setLabour(null)}
        />
      )}
    </div>
  );
}

function EditJob({ job, onClose, onSaved }: { job: JobDetail; onClose: () => void; onSaved: (j: JobDetail) => void }) {
  const meta = useLoadedMeta();
  const [f, setF] = useState({ priority: job.priority, title: job.title, description: job.description, offRoad: job.offRoad, scheduledFor: job.scheduledFor ?? "", assignedTo: job.assignedTo ?? "" });
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      onSaved(await api<JobDetail>(`/jobs/${job.id}`, { method: "PUT", body: { ...f, version: job.version, scheduledFor: f.scheduledFor || null, assignedTo: f.assignedTo || null } }));
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <Modal title={`Edit ${job.number}`} onClose={onClose}>
      <label>Title<input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
      <label>Details<textarea rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
      <div className="grid-2">
        <label>
          Priority
          <select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value as JobDetail["priority"] })}>
            <option value="low">Low</option><option value="normal">Normal</option><option value="urgent">Urgent</option>
          </select>
        </label>
        <label>Booked for<input type="date" value={f.scheduledFor} onChange={(e) => setF({ ...f, scheduledFor: e.target.value })} /></label>
      </div>
      <label>
        Technician
        <select value={f.assignedTo} onChange={(e) => setF({ ...f, assignedTo: e.target.value })}>
          <option value="">Unassigned</option>
          {meta.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      </label>
      <label className="check"><input type="checkbox" checked={f.offRoad} onChange={(e) => setF({ ...f, offRoad: e.target.checked })} /> Off the road until done</label>
      {error && <div className="notice notice-bad">{error}</div>}
      <div className="row"><span className="spacer" /><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={save}>Save</button></div>
    </Modal>
  );
}

function EditLabour({ entry, onClose, onSave, onDelete }: { entry: LabourEntry; onClose: () => void; onSave: (s: string, e: string) => void; onDelete: () => void }) {
  const [start, setStart] = useState(toLocalInput(entry.startedAt));
  const [end, setEnd] = useState(toLocalInput(entry.endedAt));
  const s = fromLocalInput(start);
  const e = fromLocalInput(end);
  return (
    <Modal title={`Correct ${entry.technicianName}'s time`} onClose={onClose}>
      <div className="grid-2">
        <label>Started<input type="datetime-local" value={start} onChange={(ev) => setStart(ev.target.value)} /></label>
        <label>Ended<input type="datetime-local" value={end} onChange={(ev) => setEnd(ev.target.value)} /></label>
      </div>
      <p className="muted small">Corrections are recorded in the activity log.</p>
      <div className="row">
        <button className="btn btn-danger" onClick={() => window.confirm("Delete this time entry?") && onDelete()}>Delete</button>
        <span className="spacer" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!s || !e} onClick={() => s && e && onSave(s, e)}>Save</button>
      </div>
    </Modal>
  );
}
