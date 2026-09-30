import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMe } from "../api/auth";
import { api, errorText } from "../api/client";
import { Status } from "../components/ui";
import { fmtDateTime, fmtMinutes, KIND_LABEL } from "../lib/format";
import { dismissFailed, enqueue, flush, initOutbox, useOutbox, type QueuedOp } from "../lib/outbox";
import { checklistProblems } from "../../../shared/fleet";
import type { CheckResult } from "../../../shared/schemas";
import type { Job, JobDetail, Part } from "../../../shared/types";

// ---- a small offline cache: the last good copy of each screen's data, kept on the phone ----

function useCached<T>(key: string[], path: string) {
  const storageKey = `fleet-cache:${key.join(":")}`;
  return useQuery({
    queryKey: key,
    queryFn: async () => {
      const data = await api<T>(path);
      try {
        localStorage.setItem(storageKey, JSON.stringify(data));
      } catch {
        // storage full: just no offline copy
      }
      return data;
    },
    initialData: () => {
      try {
        const raw = localStorage.getItem(storageKey);
        return raw ? (JSON.parse(raw) as T) : undefined;
      } catch {
        return undefined;
      }
    },
    initialDataUpdatedAt: 0, // always refresh from the server when there is signal
    retry: 1,
  });
}

function useTechOutbox() {
  const me = useMe().data!;
  const qc = useQueryClient();
  useEffect(() => initOutbox(me.id, () => void qc.invalidateQueries({ queryKey: ["tech"] })), [me.id, qc]);
  return useOutbox();
}

function SyncBar() {
  const box = useTechOutbox();
  return (
    <div className="stack" aria-live="polite">
      {box.queue.length > 0 && (
        <div className={`notice ${box.lastError ? "notice-warn" : ""}`}>
          {box.lastError ?? `Sending ${box.queue.length} change${box.queue.length === 1 ? "" : "s"}…`}{" "}
          {box.lastError && (
            <button className="btn btn-sm" onClick={() => void flush()}>
              Try now
            </button>
          )}
        </div>
      )}
      {box.failed.map((f) => (
        <div key={f.op.opId} className="notice notice-bad">
          <b>Not saved:</b> {f.op.label}. {f.message}{" "}
          <button className="btn btn-sm" onClick={() => dismissFailed(f.op.opId)}>
            OK
          </button>
        </div>
      ))}
    </div>
  );
}

// ---- my jobs ----

export function TechHome() {
  const q = useCached<{ items: Job[]; runningTimer: { jobId: string; startedAt: string } | null }>(["tech", "jobs"], "/tech/jobs");
  const me = useMe().data!;
  if (!q.data) return <div className="wrap">{q.isError ? <div className="notice">{errorText(q.error)}</div> : <p className="muted">Loading…</p>}</div>;
  const mine = q.data.items.filter((j) => j.assignedTo === me.id);
  const free = q.data.items.filter((j) => !j.assignedTo);
  const card = (j: Job) => (
    <li key={j.id}>
      <Link to={`/tech/${j.id}`} className="tech-job">
        <span className="plate">{j.plate}</span>
        <span className="grow">
          <b>{j.title}</b>
          <span className="muted small">
            {j.bikeName} · {j.clientName} · {KIND_LABEL[j.kind]}
            {j.scheduledFor ? ` · for ${j.scheduledFor}` : ""}
          </span>
        </span>
        <span className="tags">
          {q.data.runningTimer?.jobId === j.id && <span className="badge badge-warn">Clock running</span>}
          {j.priority === "urgent" && <Status value="urgent" />}
          {j.offRoad && <Status value="off_road" />}
          <Status value={j.status} />
        </span>
      </Link>
    </li>
  );
  return (
    <div className="wrap narrow stack">
      <SyncBar />
      {q.isError && <div className="notice notice-warn">Showing the copy saved on this phone. {errorText(q.error)}</div>}
      <h1>My jobs</h1>
      {mine.length ? <ul className="tech-list">{mine.map(card)}</ul> : <p className="muted">Nothing assigned to you.</p>}
      <h2>Unassigned</h2>
      <p className="muted small">Starting the clock on one of these takes it.</p>
      {free.length ? <ul className="tech-list">{free.map(card)}</ul> : <p className="muted">No unassigned jobs.</p>}
    </div>
  );
}

// ---- one job ----

/** The server's copy of the job with this phone's unsent changes laid over it. */
function withPending(job: JobDetail, ops: QueuedOp[], parts: Part[], myName: string): JobDetail {
  const j: JobDetail = { ...job, checklist: job.checklist.map((i) => ({ ...i })), notes: [...job.notes], parts: [...job.parts] };
  for (const op of ops) {
    if (op.type === "start") {
      j.myTimerStartedAt = op.at;
      if (j.status !== "done") j.status = "in_progress";
    } else if (op.type === "stop") j.myTimerStartedAt = null;
    else if (op.type === "check") {
      const i = j.checklist.find((c) => c.key === op.key);
      if (i) Object.assign(i, { result: op.result, note: op.note });
    } else if (op.type === "note") j.notes.push({ id: op.opId, at: op.at, author: `${myName} (not sent yet)`, text: op.text });
    else if (op.type === "part") {
      const p = parts.find((x) => x.id === op.partId);
      j.parts.push({ id: op.opId, partId: op.partId, sku: p?.sku ?? "", name: `${p?.name ?? "Part"} (not sent yet)`, unit: p?.unit ?? "each", qty: op.qty, unitPriceCents: p?.priceCents ?? 0 });
    } else if (op.type === "waiting_parts") {
      j.status = "waiting_parts";
      j.myTimerStartedAt = null;
    } else if (op.type === "complete") {
      j.status = "done";
      j.myTimerStartedAt = null;
    }
  }
  return j;
}

function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  return <>{fmtMinutes(Math.max(0, (now - Date.parse(since)) / 60_000))}</>;
}

const RESULTS: { v: CheckResult; label: string }[] = [
  { v: "pass", label: "Pass" },
  { v: "fail", label: "Fail" },
  { v: "na", label: "N/A" },
];

export function TechJob() {
  const { id = "" } = useParams();
  const me = useMe().data!;
  const box = useTechOutbox();
  const q = useCached<JobDetail>(["tech", "job", id], `/jobs/${id}`);
  const partsQ = useCached<{ items: Part[] }>(["tech", "parts"], "/parts");
  const parts = useMemo(() => partsQ.data?.items ?? [], [partsQ.data]);
  const [note, setNote] = useState("");
  const [partSearch, setPartSearch] = useState("");
  const [partQty, setPartQty] = useState("1");
  const [odometer, setOdometer] = useState("");
  const [summary, setSummary] = useState("");
  const [completeError, setCompleteError] = useState<string | null>(null);
  const [photoMsg, setPhotoMsg] = useState<string | null>(null);

  if (!q.data) return <div className="wrap">{q.isError ? <div className="notice">{errorText(q.error)}</div> : <p className="muted">Loading…</p>}</div>;
  const job = withPending(q.data, box.queue.filter((o) => o.jobId === id), parts, me.name);
  const open = job.status !== "done" && job.status !== "cancelled";
  const running = job.myTimerStartedAt;
  const send = (op: Parameters<typeof enqueue>[0]) => enqueue(op);
  const matches = partSearch.trim().length >= 2 ? parts.filter((p) => `${p.sku} ${p.name}`.toLowerCase().includes(partSearch.trim().toLowerCase())).slice(0, 6) : [];

  const complete = () => {
    const problems = checklistProblems(job.checklist);
    const km = Number(odometer);
    if (!odometer.trim() || !Number.isInteger(km) || km < 0) return setCompleteError("Enter the odometer reading in km.");
    if (problems.length) return setCompleteError(problems.join(". "));
    setCompleteError(null);
    send({ type: "complete", jobId: id, odometerKm: km, summary: summary.trim(), label: `Sign off ${job.number}` });
  };

  const uploadPhoto = async (file: File) => {
    setPhotoMsg("Uploading…");
    const form = new FormData();
    form.append("file", file);
    try {
      await api(`/jobs/${id}/photos`, { method: "POST", form });
      setPhotoMsg("Photo added.");
      void q.refetch();
    } catch (e) {
      setPhotoMsg(`Photo not added: ${errorText(e)} Photos need a connection.`);
    }
  };

  return (
    <div className="wrap narrow stack tech">
      <SyncBar />
      <Link to="/tech" className="small">
        ← My jobs
      </Link>
      <div className="card stack">
        <div className="row">
          <span className="plate big">{job.plate}</span>
          <span className="spacer" />
          {job.offRoad && <Status value="off_road" />}
          <Status value={job.status} />
        </div>
        <h1>{job.title}</h1>
        <p className="muted">
          {job.number} · {KIND_LABEL[job.kind]} · {job.bikeName} · {job.clientName}
        </p>
        {job.description && <p className="pre">{job.description}</p>}
        {open && (
          <button
            className={`btn btn-xl ${running ? "btn-danger" : "btn-primary"}`}
            onClick={() => send({ type: running ? "stop" : "start", jobId: id, label: `${running ? "Stop" : "Start"} clock on ${job.number}` })}
          >
            {running ? (
              <>
                Stop clock · <Elapsed since={running} />
              </>
            ) : (
              "Start clock"
            )}
          </button>
        )}
        <p className="muted small">Time on this job so far: {fmtMinutes(job.labourMinutes)}</p>
      </div>

      {job.checklist.length > 0 && (
        <section className="card stack">
          <h2>Checklist</h2>
          <ul className="checklist">
            {job.checklist.map((i) => (
              <li key={i.key} className={i.result === "fail" ? "failed" : ""}>
                <div className="row">
                  <span className="grow">
                    {i.label}
                    {i.safety && <span className="muted small"> · safety</span>}
                  </span>
                  <span className="seg" role="radiogroup" aria-label={i.label}>
                    {RESULTS.map((r) => (
                      <button
                        key={r.v}
                        type="button"
                        role="radio"
                        aria-checked={i.result === r.v}
                        disabled={!open}
                        className={i.result === r.v ? `on on-${r.v}` : ""}
                        onClick={() => send({ type: "check", jobId: id, key: i.key, result: i.result === r.v ? null : r.v, note: i.note, label: `${i.label}: ${r.label}` })}
                      >
                        {r.label}
                      </button>
                    ))}
                  </span>
                </div>
                {i.result === "fail" && (
                  <input
                    aria-label={`What is wrong with ${i.label}`}
                    placeholder="What is wrong?"
                    defaultValue={i.note}
                    disabled={!open}
                    onBlur={(e) => e.target.value.trim() !== i.note && send({ type: "check", jobId: id, key: i.key, result: "fail", note: e.target.value.trim(), label: `${i.label} note` })}
                  />
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card stack">
        <h2>Parts used</h2>
        {job.parts.length ? (
          <ul className="plain">
            {job.parts.map((p) => (
              <li key={p.id}>
                {p.qty} × {p.sku} {p.name}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">None yet.</p>
        )}
        {open && (
          <>
            <div className="row">
              <input aria-label="Find a part" placeholder="Find a part (name or number)" value={partSearch} onChange={(e) => setPartSearch(e.target.value)} className="grow" />
              <input aria-label="Quantity" inputMode="decimal" value={partQty} onChange={(e) => setPartQty(e.target.value)} style={{ width: 70 }} />
            </div>
            <ul className="plain">
              {matches.map((p) => (
                <li key={p.id} className="row">
                  <span className="grow">
                    {p.sku} {p.name} <span className="muted small">({p.stockQty} in stock)</span>
                  </span>
                  <button
                    className="btn btn-sm"
                    onClick={() => {
                      const qty = Number(partQty);
                      if (!(qty > 0)) return;
                      send({ type: "part", jobId: id, partId: p.id, qty, label: `${qty} × ${p.sku} on ${job.number}` });
                      setPartSearch("");
                      setPartQty("1");
                    }}
                  >
                    Add
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="card stack">
        <h2>Notes and photos</h2>
        {job.notes.map((n) => (
          <p key={n.id} className="note">
            <span className="muted small">
              {n.author} · {fmtDateTime(n.at)}
            </span>
            <br />
            {n.text}
          </p>
        ))}
        <textarea aria-label="Add a note" placeholder="Add a note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
        <div className="row">
          <button
            className="btn"
            disabled={!note.trim()}
            onClick={() => {
              send({ type: "note", jobId: id, text: note.trim(), label: `Note on ${job.number}` });
              setNote("");
            }}
          >
            Save note
          </button>
          <label className="btn">
            Add photo
            <input type="file" accept="image/*" capture="environment" hidden onChange={(e) => e.target.files?.[0] && void uploadPhoto(e.target.files[0])} />
          </label>
          <span className="muted small">{job.photos.length} photo{job.photos.length === 1 ? "" : "s"}</span>
        </div>
        {photoMsg && <p className="small">{photoMsg}</p>}
      </section>

      {open && (
        <section className="card stack">
          <h2>Finish</h2>
          {job.status !== "waiting_parts" && (
            <button className="btn" onClick={() => send({ type: "waiting_parts", jobId: id, label: `${job.number} waiting for parts` })}>
              Waiting for parts (stops the clock)
            </button>
          )}
          <label>
            Odometer (km)
            <input inputMode="numeric" value={odometer} onChange={(e) => setOdometer(e.target.value.replace(/\D/g, ""))} placeholder={String(q.data.odometerKm ?? "")} />
          </label>
          <label>
            Work done (the client sees this)
            <textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={2} />
          </label>
          {completeError && <div className="notice notice-bad">{completeError}</div>}
          <button className="btn btn-primary btn-xl" onClick={complete}>
            Sign off job
          </button>
          <p className="muted small">Failed safety checks keep the bike off the road under a new urgent repair job.</p>
        </section>
      )}
    </div>
  );
}
