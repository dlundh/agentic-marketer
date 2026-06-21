import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// SQLite persistence. Uses Node 26's built-in node:sqlite (no native build).
// A single DB file under ./data survives page reloads AND server restarts, so
// jobs/history/results can be resumed later. We keep one connection on
// globalThis so Next.js HMR doesn't open a new handle on every reload.
// ---------------------------------------------------------------------------

export const DATA_DIR = path.join(process.cwd(), 'data');
export const FILES_DIR = path.join(DATA_DIR, 'files');
mkdirSync(FILES_DIR, { recursive: true });

const g = globalThis as unknown as { __db?: DatabaseSync };

function init(): DatabaseSync {
  const db = new DatabaseSync(path.join(DATA_DIR, 'marketer.db'));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  // Several route bundles may each open a connection to this same file (Next dev
  // does not share module singletons across bundles). WAL + a busy timeout lets
  // those connections read/write the shared file without SQLITE_BUSY errors.
  db.exec('PRAGMA busy_timeout = 8000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id           TEXT PRIMARY KEY,
      title        TEXT NOT NULL,
      prompt       TEXT NOT NULL,
      url          TEXT,
      phase        TEXT NOT NULL DEFAULT 'research',   -- research | marketing | done
      status       TEXT NOT NULL DEFAULT 'active',      -- active | done
      summary      TEXT,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id           TEXT PRIMARY KEY,
      project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      kind         TEXT NOT NULL,                        -- research | marketing
      title        TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'queued',       -- queued | running | paused | done | error
      phase        TEXT,
      session_id   TEXT,                                 -- SDK session id for resume
      summary      TEXT,
      error        TEXT,
      heartbeat    INTEGER,                               -- last sign-of-life from a running loop
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS activity (
      id           TEXT PRIMARY KEY,
      job_id       TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      project_id   TEXT NOT NULL,
      kind         TEXT NOT NULL,                        -- thinking | text | tool_use | tool_result | status | error
      label        TEXT,                                 -- e.g. tool name / status
      content      TEXT,
      created_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS findings (
      id           TEXT PRIMARY KEY,
      project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      job_id       TEXT,
      category     TEXT,
      title        TEXT NOT NULL,
      summary      TEXT,
      details      TEXT,
      created_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS files (
      id           TEXT PRIMARY KEY,
      project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      job_id       TEXT,
      name         TEXT NOT NULL,
      path         TEXT NOT NULL,
      mime         TEXT NOT NULL DEFAULT 'application/octet-stream',
      size         INTEGER NOT NULL DEFAULT 0,
      kind         TEXT,                                 -- report | attachment | asset
      created_at   INTEGER NOT NULL
    );

    -- Execution phase: a budgeted campaign, the channel connectors it can use,
    -- and the queue of concrete marketing actions the swarm proposes.
    CREATE TABLE IF NOT EXISTS campaigns (
      id            TEXT PRIMARY KEY,
      project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      status        TEXT NOT NULL DEFAULT 'active',       -- active | paused | done
      currency      TEXT NOT NULL DEFAULT 'USD',
      budget_cents  INTEGER NOT NULL DEFAULT 0,           -- hard ceiling (0 = pure organic)
      spent_cents   INTEGER NOT NULL DEFAULT 0,           -- committed + executed spend
      channels      TEXT,                                 -- JSON array of selected channel keys
      autonomy      TEXT NOT NULL DEFAULT 'approval',     -- approval | autonomous
      strategy      TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );

    -- Connectors are GLOBAL (an account is connected once, reused by any campaign).
    CREATE TABLE IF NOT EXISTS connectors (
      key           TEXT PRIMARY KEY,                     -- channel key, e.g. 'webhook','smtp','x','meta_ads'
      label         TEXT NOT NULL,
      executor      TEXT NOT NULL,                        -- webhook | smtp | manual
      secrets       TEXT,                                 -- JSON credentials/config
      connected     INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS actions (
      id            TEXT PRIMARY KEY,
      project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      campaign_id   TEXT NOT NULL,
      job_id        TEXT,                                 -- swarm agent that proposed it
      channel       TEXT NOT NULL,                        -- channel key
      kind          TEXT NOT NULL,                        -- post | thread | ad | email | outreach | experiment | asset | seo
      title         TEXT NOT NULL,
      summary       TEXT,
      content       TEXT,                                 -- the actual copy / payload (markdown)
      meta          TEXT,                                 -- JSON: targeting, schedule hints, links, rationale
      cost_cents    INTEGER NOT NULL DEFAULT 0,           -- estimated spend if executed
      status        TEXT NOT NULL DEFAULT 'proposed',     -- proposed | approved | rejected | ready | done | failed
      result        TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_project   ON jobs(project_id);
    CREATE INDEX IF NOT EXISTS idx_activity_job   ON activity(job_id);
    CREATE INDEX IF NOT EXISTS idx_activity_proj  ON activity(project_id);
    CREATE INDEX IF NOT EXISTS idx_findings_proj  ON findings(project_id);
    CREATE INDEX IF NOT EXISTS idx_files_proj     ON files(project_id);
    CREATE INDEX IF NOT EXISTS idx_campaigns_proj ON campaigns(project_id);
    CREATE INDEX IF NOT EXISTS idx_actions_proj   ON actions(project_id);
    CREATE INDEX IF NOT EXISTS idx_actions_camp   ON actions(campaign_id);
  `);

  // NB: recovery of interrupted jobs is handled by orchestrator.reconcile(),
  // which is guarded by the live in-memory run registry so it can never flip a
  // job that is actually still running in this process.
  return db;
}

export const db: DatabaseSync = g.__db ?? (g.__db = init());

export const now = () => Date.now();
export const uid = (p = '') =>
  p + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

// --- typed row helpers ------------------------------------------------------

export type Project = {
  id: string; title: string; prompt: string; url: string | null;
  phase: string; status: string; summary: string | null;
  created_at: number; updated_at: number;
};
export type Job = {
  id: string; project_id: string; kind: string; title: string; status: string;
  phase: string | null; session_id: string | null; summary: string | null;
  error: string | null; heartbeat: number | null; created_at: number; updated_at: number;
};
export type Activity = {
  id: string; job_id: string; project_id: string; kind: string;
  label: string | null; content: string | null; created_at: number;
};
export type Finding = {
  id: string; project_id: string; job_id: string | null; category: string | null;
  title: string; summary: string | null; details: string | null; created_at: number;
};
export type FileRow = {
  id: string; project_id: string; job_id: string | null; name: string; path: string;
  mime: string; size: number; kind: string | null; created_at: number;
};

// --- writes -----------------------------------------------------------------

export function createProject(p: { title: string; prompt: string; url?: string | null }): Project {
  const id = uid('p_'); const t = now();
  db.prepare(
    `INSERT INTO projects (id,title,prompt,url,phase,status,created_at,updated_at)
     VALUES (?,?,?,?, 'research','active', ?,?)`
  ).run(id, p.title, p.prompt, p.url ?? null, t, t);
  return getProject(id)!;
}

export function updateProject(id: string, patch: Partial<Project>) {
  const cur = getProject(id); if (!cur) return;
  const next = { ...cur, ...patch, updated_at: now() };
  db.prepare(
    `UPDATE projects SET title=?,phase=?,status=?,summary=?,updated_at=? WHERE id=?`
  ).run(next.title, next.phase, next.status, next.summary ?? null, next.updated_at, id);
}

export function createJob(j: { project_id: string; kind: string; title: string; phase?: string }): Job {
  const id = uid('j_'); const t = now();
  db.prepare(
    `INSERT INTO jobs (id,project_id,kind,title,status,phase,created_at,updated_at)
     VALUES (?,?,?,?, 'queued', ?, ?,?)`
  ).run(id, j.project_id, j.kind, j.title, j.phase ?? null, t, t);
  return getJob(id)!;
}

export function updateJob(id: string, patch: Partial<Job>) {
  const cur = getJob(id); if (!cur) return;
  const next = { ...cur, ...patch, updated_at: now() };
  db.prepare(
    `UPDATE jobs SET status=?,session_id=?,summary=?,error=?,phase=?,title=?,updated_at=? WHERE id=?`
  ).run(next.status, next.session_id ?? null, next.summary ?? null, next.error ?? null,
        next.phase ?? null, next.title, next.updated_at, id);
}

// Lightweight sign-of-life so reconcile() can tell a job that's genuinely
// running (in any bundle) from one orphaned by a server restart.
export function touchJob(id: string) {
  db.prepare(`UPDATE jobs SET heartbeat=? WHERE id=?`).run(now(), id);
}

export function addActivity(a: {
  job_id: string; project_id: string; kind: string; label?: string; content?: string;
}): Activity {
  const id = uid('a_'); const t = now();
  db.prepare(
    `INSERT INTO activity (id,job_id,project_id,kind,label,content,created_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run(id, a.job_id, a.project_id, a.kind, a.label ?? null, a.content ?? null, t);
  return { id, created_at: t, label: a.label ?? null, content: a.content ?? null, ...a } as Activity;
}

export function addFinding(f: {
  project_id: string; job_id?: string; category?: string; title: string;
  summary?: string; details?: string;
}): Finding {
  const id = uid('f_'); const t = now();
  db.prepare(
    `INSERT INTO findings (id,project_id,job_id,category,title,summary,details,created_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(id, f.project_id, f.job_id ?? null, f.category ?? null, f.title, f.summary ?? null,
        f.details ?? null, t);
  return getFinding(id)!;
}

export function addFile(f: {
  project_id: string; job_id?: string; name: string; path: string; mime?: string;
  size?: number; kind?: string;
}): FileRow {
  const id = uid('file_'); const t = now();
  db.prepare(
    `INSERT INTO files (id,project_id,job_id,name,path,mime,size,kind,created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(id, f.project_id, f.job_id ?? null, f.name, f.path, f.mime ?? 'application/octet-stream',
        f.size ?? 0, f.kind ?? null, t);
  return db.prepare(`SELECT * FROM files WHERE id=?`).get(id) as FileRow;
}

// --- reads ------------------------------------------------------------------

export const getProject = (id: string) =>
  db.prepare(`SELECT * FROM projects WHERE id=?`).get(id) as Project | undefined;
export const listProjects = () =>
  db.prepare(`SELECT * FROM projects ORDER BY updated_at DESC`).all() as Project[];
export const getJob = (id: string) =>
  db.prepare(`SELECT * FROM jobs WHERE id=?`).get(id) as Job | undefined;
export const listJobs = (projectId: string) =>
  db.prepare(`SELECT * FROM jobs WHERE project_id=? ORDER BY created_at ASC`).all(projectId) as Job[];
export const listAllActiveJobs = () =>
  db.prepare(`SELECT * FROM jobs WHERE status IN ('queued','running','paused') ORDER BY created_at ASC`).all() as Job[];
export const listActivity = (jobId: string) =>
  db.prepare(`SELECT * FROM activity WHERE job_id=? ORDER BY created_at ASC`).all(jobId) as Activity[];
export const getFinding = (id: string) =>
  db.prepare(`SELECT * FROM findings WHERE id=?`).get(id) as Finding | undefined;
export const listFindings = (projectId: string) =>
  db.prepare(`SELECT * FROM findings WHERE project_id=? ORDER BY created_at ASC`).all(projectId) as Finding[];
export const listFiles = (projectId: string) =>
  db.prepare(`SELECT * FROM files WHERE project_id=? ORDER BY created_at ASC`).all(projectId) as FileRow[];
export const listJobFiles = (jobId: string) =>
  db.prepare(`SELECT * FROM files WHERE job_id=? ORDER BY created_at ASC`).all(jobId) as FileRow[];
export const getFile = (id: string) =>
  db.prepare(`SELECT * FROM files WHERE id=?`).get(id) as FileRow | undefined;

// Cheap fingerprint of all mutable state. The SSE route polls this so the
// browser refetches whenever anything changes — independent of the in-process
// event bus (which may be duplicated across Next route bundles).
export function changeSignature(): string {
  const a = db.prepare(`SELECT COALESCE(MAX(created_at),0) m, COUNT(*) c FROM activity`).get() as any;
  const j = db.prepare(`SELECT COALESCE(MAX(updated_at),0) m, COUNT(*) c FROM jobs`).get() as any;
  const p = db.prepare(`SELECT COALESCE(MAX(updated_at),0) m, COUNT(*) c FROM projects`).get() as any;
  const f = db.prepare(`SELECT COALESCE(MAX(created_at),0) m, COUNT(*) c FROM files`).get() as any;
  const c = db.prepare(`SELECT COALESCE(MAX(updated_at),0) m, COUNT(*) c FROM campaigns`).get() as any;
  const ac = db.prepare(`SELECT COALESCE(MAX(updated_at),0) m, COUNT(*) c FROM actions`).get() as any;
  return `${a.m}.${a.c}_${j.m}.${j.c}_${p.m}.${p.c}_${f.m}.${f.c}_${c.m}.${c.c}_${ac.m}.${ac.c}`;
}

// ---------------------------------------------------------------------------
// Execution phase: campaigns, connectors, actions.
// ---------------------------------------------------------------------------

export type Campaign = {
  id: string; project_id: string; status: string; currency: string;
  budget_cents: number; spent_cents: number; channels: string | null;
  autonomy: string; strategy: string | null; created_at: number; updated_at: number;
};
export type Connector = {
  key: string; label: string; executor: string; secrets: string | null;
  connected: number; created_at: number; updated_at: number;
};
export type ActionRow = {
  id: string; project_id: string; campaign_id: string; job_id: string | null;
  channel: string; kind: string; title: string; summary: string | null;
  content: string | null; meta: string | null; cost_cents: number;
  status: string; result: string | null; created_at: number; updated_at: number;
};

export function createCampaign(c: {
  project_id: string; budget_cents: number; currency?: string; channels: string[]; autonomy?: string;
}): Campaign {
  const id = uid('c_'); const t = now();
  db.prepare(
    `INSERT INTO campaigns (id,project_id,status,currency,budget_cents,spent_cents,channels,autonomy,created_at,updated_at)
     VALUES (?,?, 'active', ?, ?, 0, ?, ?, ?,?)`
  ).run(id, c.project_id, c.currency ?? 'USD', c.budget_cents, JSON.stringify(c.channels),
        c.autonomy ?? 'approval', t, t);
  return getCampaign(id)!;
}
export const getCampaign = (id: string) =>
  db.prepare(`SELECT * FROM campaigns WHERE id=?`).get(id) as Campaign | undefined;
export const getCampaignByProject = (projectId: string) =>
  db.prepare(`SELECT * FROM campaigns WHERE project_id=? ORDER BY created_at DESC LIMIT 1`).get(projectId) as Campaign | undefined;
export function updateCampaign(id: string, patch: Partial<Campaign>) {
  const cur = getCampaign(id); if (!cur) return;
  const n = { ...cur, ...patch, updated_at: now() };
  db.prepare(`UPDATE campaigns SET status=?,budget_cents=?,spent_cents=?,channels=?,autonomy=?,strategy=?,updated_at=? WHERE id=?`)
    .run(n.status, n.budget_cents, n.spent_cents, n.channels ?? null, n.autonomy, n.strategy ?? null, n.updated_at, id);
}
// Atomically reserve spend against the hard cap. Returns false if it would bust budget.
export function reserveSpend(campaignId: string, cents: number): boolean {
  const c = getCampaign(campaignId); if (!c) return false;
  if (cents <= 0) return true;
  if (c.spent_cents + cents > c.budget_cents) return false;
  db.prepare(`UPDATE campaigns SET spent_cents=spent_cents+?, updated_at=? WHERE id=?`).run(cents, now(), campaignId);
  return true;
}
export function refundSpend(campaignId: string, cents: number) {
  if (cents <= 0) return;
  db.prepare(`UPDATE campaigns SET spent_cents=MAX(0,spent_cents-?), updated_at=? WHERE id=?`).run(cents, now(), campaignId);
}

export function upsertConnector(c: { key: string; label: string; executor: string; secrets?: any; connected: boolean }) {
  const t = now();
  const secrets = c.secrets ? JSON.stringify(c.secrets) : null;
  db.prepare(
    `INSERT INTO connectors (key,label,executor,secrets,connected,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET label=excluded.label, executor=excluded.executor,
       secrets=COALESCE(excluded.secrets, connectors.secrets), connected=excluded.connected, updated_at=excluded.updated_at`
  ).run(c.key, c.label, c.executor, secrets, c.connected ? 1 : 0, t, t);
}
export const getConnector = (key: string) =>
  db.prepare(`SELECT * FROM connectors WHERE key=?`).get(key) as Connector | undefined;
export const listConnectors = () =>
  db.prepare(`SELECT * FROM connectors ORDER BY key ASC`).all() as Connector[];
export function disconnectConnector(key: string) {
  db.prepare(`UPDATE connectors SET connected=0, secrets=NULL, updated_at=? WHERE key=?`).run(now(), key);
}

export function createAction(a: {
  project_id: string; campaign_id: string; job_id?: string; channel: string; kind: string;
  title: string; summary?: string; content?: string; meta?: any; cost_cents?: number; status?: string;
}): ActionRow {
  const id = uid('act_'); const t = now();
  db.prepare(
    `INSERT INTO actions (id,project_id,campaign_id,job_id,channel,kind,title,summary,content,meta,cost_cents,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, a.project_id, a.campaign_id, a.job_id ?? null, a.channel, a.kind, a.title,
        a.summary ?? null, a.content ?? null, a.meta ? JSON.stringify(a.meta) : null,
        a.cost_cents ?? 0, a.status ?? 'proposed', t, t);
  return getAction(id)!;
}
export const getAction = (id: string) =>
  db.prepare(`SELECT * FROM actions WHERE id=?`).get(id) as ActionRow | undefined;
export const listActions = (campaignId: string) =>
  db.prepare(`SELECT * FROM actions WHERE campaign_id=? ORDER BY created_at ASC`).all(campaignId) as ActionRow[];
export function updateAction(id: string, patch: Partial<ActionRow>) {
  const cur = getAction(id); if (!cur) return;
  const n = { ...cur, ...patch, updated_at: now() };
  db.prepare(`UPDATE actions SET status=?,result=?,title=?,summary=?,content=?,meta=?,cost_cents=?,updated_at=? WHERE id=?`)
    .run(n.status, n.result ?? null, n.title, n.summary ?? null, n.content ?? null, n.meta ?? null, n.cost_cents, n.updated_at, id);
}
