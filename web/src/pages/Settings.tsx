import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useLoadedMeta, useMe } from "../api/auth";
import { api, errorText } from "../api/client";
import { Modal, MoneyInput } from "../components/ui";
import { ROLES, type Role } from "../../../shared/schemas";
import type { Settings as S } from "../../../shared/types";

type Checklist = S["serviceChecklist"];
/** One item per line; a leading * marks a safety item. */
const toText = (c: Checklist) => c.map((i) => `${i.safety ? "* " : ""}${i.label}`).join("\n");
function fromText(t: string): Checklist {
  const used = new Set<string>();
  return t
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const safety = l.startsWith("*");
      const label = l.replace(/^\*\s*/, "");
      let key = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 36) || "item";
      while (used.has(key)) key += "_";
      used.add(key);
      return { key, label, safety };
    });
}

export function Settings() {
  const me = useMe().data!;
  const meta = useLoadedMeta();
  const qc = useQueryClient();
  const [s, setS] = useState(meta.settings);
  const [service, setService] = useState(toText(meta.settings.serviceChecklist));
  const [inspection, setInspection] = useState(toText(meta.settings.inspectionChecklist));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (me.role !== "admin") return <div className="wrap"><div className="notice">Only admins can change settings.</div></div>;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api("/settings", { method: "PUT", body: { ...s, serviceChecklist: fromText(service), inspectionChecklist: fromText(inspection) } });
      await qc.invalidateQueries({ queryKey: ["meta"] });
      setMsg({ ok: true, text: "Saved. New checklists apply to jobs created from now on." });
    } catch (err) {
      setMsg({ ok: false, text: errorText(err) });
    }
  };
  const num = (k: keyof S, label: string) => (
    <label>{label}<input inputMode="decimal" value={String(s[k])} onChange={(e) => setS({ ...s, [k]: Number(e.target.value) })} /></label>
  );
  return (
    <div className="wrap stack">
      <h1>Settings</h1>
      <form className="card stack" onSubmit={save}>
        <div className="grid-2">
          <label>Business name<input value={s.companyName} onChange={(e) => setS({ ...s, companyName: e.target.value })} /></label>
          <label>Address (on invoices)<textarea rows={2} value={s.companyAddress} onChange={(e) => setS({ ...s, companyAddress: e.target.value })} /></label>
        </div>
        <div className="grid-3">
          <label>Currency<input value={s.currency} onChange={(e) => setS({ ...s, currency: e.target.value.toUpperCase() })} /></label>
          <label>Locale<input value={s.locale} onChange={(e) => setS({ ...s, locale: e.target.value })} /></label>
          {num("taxPercent", "Tax %")}
          <MoneyInput label="Default labour rate per hour" cents={s.labourRateCents} onChange={(c) => setS({ ...s, labourRateCents: c })} />
          {num("labourBlockMinutes", "Bill labour in blocks of (minutes)")}
          {num("paymentTermsDays", "Payment terms (days)")}
          {num("dueSoonKm", "“Due soon” within km")}
          {num("dueSoonDays", "“Due soon” within days")}
        </div>
        <div className="grid-2">
          <label>Service checklist<textarea rows={12} value={service} onChange={(e) => setService(e.target.value)} /></label>
          <label>Inspection checklist<textarea rows={12} value={inspection} onChange={(e) => setInspection(e.target.value)} /></label>
        </div>
        <p className="muted small">One item per line. Start a line with * for a safety item: a failed safety item keeps the bike off the road under a follow-up repair.</p>
        {msg && <div className={`notice ${msg.ok ? "" : "notice-bad"}`}>{msg.text}</div>}
        <div className="row"><span className="spacer" /><button className="btn btn-primary">Save settings</button></div>
      </form>
      <Users />
    </div>
  );
}

interface UserRow { id: string; email: string; name: string; role: Role; clientId: string | null; clientName: string | null; active: boolean; locked: boolean }

function Users() {
  const meta = useLoadedMeta();
  const q = useQuery({ queryKey: ["users"], queryFn: () => api<{ items: UserRow[] }>("/users") });
  const [editing, setEditing] = useState<UserRow | "new" | null>(null);
  return (
    <section className="card stack">
      <div className="row"><h2>Users</h2><span className="spacer" /><button className="btn" onClick={() => setEditing("new")}>Add user</button></div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th /></tr></thead>
          <tbody>
            {q.data?.items.map((u) => (
              <tr key={u.id} className={u.active ? "" : "muted"}>
                <td>{u.name}{!u.active && " (disabled)"}{u.locked && <span className="badge badge-warn">Locked</span>}</td>
                <td>{u.email}</td>
                <td>{u.role}{u.clientName ? ` · ${u.clientName}` : ""}</td>
                <td className="num"><button className="btn btn-sm" onClick={() => setEditing(u)}>Edit</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && <UserForm user={editing === "new" ? null : editing} clients={meta.clients} onClose={() => setEditing(null)} />}
    </section>
  );
}

function UserForm({ user, clients, onClose }: { user: UserRow | null; clients: { id: string; name: string }[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ email: user?.email ?? "", name: user?.name ?? "", role: user?.role ?? ("technician" as Role), clientId: user?.clientId ?? "", active: user?.active ?? true, password: "" });
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const clientId = f.role === "client" ? f.clientId || null : null;
    try {
      if (user) {
        await api(`/users/${user.id}`, { method: "PUT", body: { name: f.name, role: f.role, clientId, active: f.active } });
        if (f.password) await api(`/users/${user.id}/password`, { method: "POST", body: { password: f.password } });
      } else {
        await api("/users", { method: "POST", body: { email: f.email, name: f.name, role: f.role, clientId, password: f.password } });
      }
      await qc.invalidateQueries({ queryKey: ["users"] });
      await qc.invalidateQueries({ queryKey: ["meta"] });
      onClose();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <Modal title={user ? `Edit ${user.name}` : "Add user"} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {!user && <label>Email<input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>}
        <label>Name<input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <div className="grid-2">
          <label>Role<select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as Role })}>{ROLES.map((r) => <option key={r} value={r}>{r}</option>)}</select></label>
          {f.role === "client" && (
            <label>Client<select required value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value })}><option value="">Choose…</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          )}
        </div>
        <label>{user ? "New password (leave empty to keep)" : "Password"}<input type="password" autoComplete="new-password" required={!user} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></label>
        {user && <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Can sign in</label>}
        {error && <div className="notice notice-bad">{error}</div>}
        <div className="row"><span className="spacer" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary">Save</button></div>
      </form>
    </Modal>
  );
}
