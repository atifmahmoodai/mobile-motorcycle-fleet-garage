import type { FastifyInstance } from "fastify";
import { todayIn } from "../config";
import { tx } from "../db";
import { HttpError, parse, requireUser } from "../http";
import { JOB_SELECT, lockJob, toJob } from "../repo/data";
import { addNote, addPart, completeJob, opTime, setCheck, setWaitingParts, startTimer, stopTimer } from "../repo/jobops";
import { techSyncSchema, type TechOp } from "../../../shared/schemas";

export interface OpResult {
  opId: string;
  ok: boolean;
  error?: string;
  message?: string;
  /** A follow-up repair job created because safety checks failed. */
  followUpId?: string | null;
}

export async function techRoutes(app: FastifyInstance) {
  const staff = requireUser("admin", "manager", "technician");

  /** The technician's list: their open jobs, then unassigned ones they can pick up. */
  app.get("/tech/jobs", { preHandler: staff }, async (req) => {
    const me = req.session!.user.id;
    const { rows } = await app.db.query(
      `${JOB_SELECT}
        WHERE j.status IN ('open', 'scheduled', 'in_progress', 'waiting_parts') AND (j.assigned_to = $1 OR j.assigned_to IS NULL)
        ORDER BY (j.assigned_to IS NULL), CASE j.priority WHEN 'urgent' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
                 j.scheduled_for NULLS LAST, j.created_at
        LIMIT 200`,
      [me],
    );
    const timer = await app.db.query<{ job_id: string; started_at: Date }>("SELECT job_id, started_at FROM job_labour WHERE technician_id = $1 AND ended_at IS NULL", [me]);
    return {
      items: rows.map(toJob),
      runningTimer: timer.rows[0] ? { jobId: timer.rows[0].job_id, startedAt: timer.rows[0].started_at.toISOString() } : null,
    };
  });

  /**
   * Replays operations a phone queued, in order. Each applies at most once (by opId). An operation the
   * rules refuse (say, a part out of stock) is recorded as failed and reported, and the rest carry on;
   * the phone shows the failures to the technician rather than retrying them forever.
   */
  app.post("/tech/sync", { preHandler: staff, config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req) => {
    const { ops } = parse(techSyncSchema, req.body);
    const user = req.session!.user;
    const results: OpResult[] = [];
    for (const op of ops) results.push(await applyOp(op));
    return { results };

    async function applyOp(op: TechOp): Promise<OpResult> {
      const seen = await app.db.query<{ result: OpResult; user_id: string }>("SELECT result, user_id FROM processed_ops WHERE op_id = $1", [op.opId]);
      if (seen.rows[0]) {
        if (seen.rows[0].user_id !== user.id) return { opId: op.opId, ok: false, error: "conflict", message: "That operation id was already used." };
        return seen.rows[0].result;
      }
      try {
        return await tx(app.db, async (c) => {
          await c.query("SAVEPOINT op");
          let result: OpResult;
          try {
            const at = opTime(op.at);
            const job = await lockJob(c, op.jobId);
            let followUpId: string | null | undefined;
            switch (op.type) {
              case "start":
                await startTimer(c, job, user, at);
                break;
              case "stop":
                await stopTimer(c, job, user, at);
                break;
              case "check":
                await setCheck(c, job, op.key, op.result, op.note);
                break;
              case "part":
                await addPart(c, job, user, op.partId, op.qty);
                break;
              case "note":
                await addNote(c, job, user, op.text, at);
                break;
              case "waiting_parts":
                await setWaitingParts(c, job, at);
                break;
              case "complete":
                followUpId = await completeJob(c, job, user, { odometerKm: op.odometerKm, summary: op.summary }, at, todayIn(app.config.TIMEZONE, at));
                break;
            }
            result = { opId: op.opId, ok: true, ...(followUpId !== undefined ? { followUpId } : {}) };
          } catch (e) {
            if (!(e instanceof HttpError)) throw e;
            await c.query("ROLLBACK TO SAVEPOINT op");
            result = { opId: op.opId, ok: false, error: e.code, message: e.message };
          }
          await c.query("INSERT INTO processed_ops (op_id, user_id, result) VALUES ($1, $2, $3)", [op.opId, user.id, JSON.stringify(result)]);
          return result;
        });
      } catch (e) {
        // Two copies of the same op racing: the other one committed first, so report its result.
        if ((e as { code?: string }).code === "23505") {
          const again = await app.db.query<{ result: OpResult }>("SELECT result FROM processed_ops WHERE op_id = $1", [op.opId]);
          if (again.rows[0]) return again.rows[0].result;
        }
        throw e;
      }
    }
  });
}
