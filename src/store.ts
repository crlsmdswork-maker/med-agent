// Persistência dos casos de MED no Postgres (Railway injeta DATABASE_URL automaticamente).
import pg from "pg";
import { config } from "./config.js";
import type { WooviDispute } from "./woovi.js";
import type { AgentDecision } from "./agent.js";

export type CaseStatus =
  | "RECEIVED" // chegou o webhook / poller
  | "ANALYZING"
  | "AWAITING_REVIEW" // defesa pronta (ou caso que precisa de humano)
  | "SUBMITTING"
  | "SUBMITTED" // evidência aceita pela Woovi
  | "NOT_DEFENDED" // aceitar devolução ou risco de fraude
  | "FAILED"
  | "CLOSED"; // Woovi mandou ACCEPTED/REJECTED/CANCELED

export interface MedCase {
  id: string; // = id da disputa na Woovi (ou endToEndId se o id não vier)
  accountKey: string;
  endToEndId: string;
  status: CaseStatus;
  deadlineAt: string;
  dispute: WooviDispute;
  decision: AgentDecision | null;
  outcome: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 5,
  ssl: config.databaseUrl.includes("sslmode=require") ? { rejectUnauthorized: false } : undefined,
});

/** Cria as tabelas se não existirem. Chamado na subida do servidor e do poller. */
export async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS med_cases (
      id TEXT PRIMARY KEY,
      account_key TEXT NOT NULL,
      end_to_end_id TEXT NOT NULL,
      status TEXT NOT NULL,
      deadline_at TIMESTAMPTZ NOT NULL,
      dispute JSONB NOT NULL,
      decision JSONB,
      outcome TEXT,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS med_cases_status_deadline ON med_cases (status, deadline_at);
    CREATE TABLE IF NOT EXISTS hosted_files (
      token TEXT PRIMARY KEY,
      content_type TEXT NOT NULL,
      data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

const toCase = (r: Record<string, any>): MedCase => ({
  id: r.id,
  accountKey: r.account_key,
  endToEndId: r.end_to_end_id,
  status: r.status,
  deadlineAt: new Date(r.deadline_at).toISOString(),
  dispute: r.dispute,
  decision: r.decision,
  outcome: r.outcome,
  error: r.error,
  createdAt: new Date(r.created_at).toISOString(),
  updatedAt: new Date(r.updated_at).toISOString(),
});

/** Cria o caso se ainda não existir (webhooks chegam repetidos). isNew = true só para quem criou. */
export async function upsertNewCase(accountKey: string, dispute: WooviDispute): Promise<{ case: MedCase; isNew: boolean }> {
  const id = dispute.id ?? dispute.endToEndId;
  const deadline = new Date(Date.now() + config.evidenceDeadlineHours * 3600_000);
  const ins = await pool.query(
    `INSERT INTO med_cases (id, account_key, end_to_end_id, status, deadline_at, dispute)
     VALUES ($1, $2, $3, 'RECEIVED', $4, $5)
     ON CONFLICT (id) DO NOTHING
     RETURNING *`,
    [id, accountKey, dispute.endToEndId, deadline, dispute],
  );
  if (ins.rows[0]) return { case: toCase(ins.rows[0]), isNew: true };
  return { case: (await getCase(id))!, isNew: false };
}

export async function getCase(id: string): Promise<MedCase | null> {
  const r = await pool.query(`SELECT * FROM med_cases WHERE id = $1`, [id]);
  return r.rows[0] ? toCase(r.rows[0]) : null;
}

export async function listCases(status?: CaseStatus): Promise<MedCase[]> {
  const r = status
    ? await pool.query(`SELECT * FROM med_cases WHERE status = $1 ORDER BY deadline_at`, [status])
    : await pool.query(`SELECT * FROM med_cases ORDER BY deadline_at DESC LIMIT 500`);
  return r.rows.map(toCase);
}

/** Troca de status atômica: só muda se o status atual for um dos esperados. Evita processar duas vezes. */
export async function transition(id: string, from: CaseStatus[], to: CaseStatus): Promise<boolean> {
  const r = await pool.query(`UPDATE med_cases SET status = $1, updated_at = now() WHERE id = $2 AND status = ANY($3)`, [to, id, from]);
  return (r.rowCount ?? 0) > 0;
}

export async function updateCase(
  id: string,
  patch: Partial<Pick<MedCase, "status" | "decision" | "outcome" | "error" | "dispute">>,
) {
  const cols: string[] = [];
  const vals: unknown[] = [];
  const map: Record<string, string> = { status: "status", decision: "decision", outcome: "outcome", error: "error", dispute: "dispute" };
  for (const [k, v] of Object.entries(patch)) {
    vals.push(k === "decision" || k === "dispute" ? (v === null ? null : JSON.stringify(v)) : v);
    cols.push(`${map[k]} = $${vals.length}`);
  }
  if (!cols.length) return;
  vals.push(id);
  await pool.query(`UPDATE med_cases SET ${cols.join(", ")}, updated_at = now() WHERE id = $${vals.length}`, vals);
}

/** Casos que ficaram presos (ex.: o serviço reiniciou no meio da análise). */
export async function findStuckCases(olderThanMinutes: number): Promise<MedCase[]> {
  const r = await pool.query(
    `SELECT * FROM med_cases
     WHERE (status = 'RECEIVED' OR status = 'ANALYZING') AND updated_at < now() - ($1 || ' minutes')::interval`,
    [String(olderThanMinutes)],
  );
  return r.rows.map(toCase);
}

export async function hostFile(token: string, contentType: string, data: Buffer) {
  await pool.query(
    `INSERT INTO hosted_files (token, content_type, data) VALUES ($1, $2, $3) ON CONFLICT (token) DO NOTHING`,
    [token, contentType, data],
  );
}

export async function getHostedFile(token: string): Promise<{ contentType: string; data: Buffer } | null> {
  const r = await pool.query(`SELECT content_type, data FROM hosted_files WHERE token = $1`, [token]);
  return r.rows[0] ? { contentType: r.rows[0].content_type, data: r.rows[0].data } : null;
}

export async function closePool() {
  await pool.end();
}
