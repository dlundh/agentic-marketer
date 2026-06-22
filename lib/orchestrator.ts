import {
  createProject, createJob, updateJob, getJob, getProject, updateProject, listJobs,
  listFindings, listAllActiveJobs, createCampaign, getCampaign, getCampaignByProject,
  updateCampaign, getAction, updateAction, reserveSpend, refundSpend, resetStaleRevisions,
  type Job, type ActionRow,
} from './db';
import { emitEvent } from './events';
import { runAgent, runRevision, runAccountKit, ROLE_LABELS } from './agent';
import { runAction, channelDef, CHANNELS, isAutoExecutable, autoChannels } from './connectors';

// ---------------------------------------------------------------------------
// Owns the lifecycle of every job. Holds an AbortController per running job so
// the user can pause; persists session ids so a paused/interrupted job can be
// resumed later (even after a server restart). Survives HMR via globalThis.
// ---------------------------------------------------------------------------

type Running = { abort: AbortController; pausedByUser: boolean };
const g = globalThis as unknown as { __running?: Map<string, Running> };
const running: Map<string, Running> = g.__running ?? (g.__running = new Map());

export function isRunning(jobId: string) {
  return running.has(jobId);
}

// Pause jobs the DB still thinks are active but which have gone silent — i.e.
// orphaned by a server restart. A job is "alive" if it's in this process's
// registry OR its heartbeat is recent (covers loops living in another bundle),
// so a genuinely-running job is never wrongly paused.
const STALE_MS = 30_000;
export function reconcile() {
  const t = Date.now();
  for (const job of listAllActiveJobs()) {
    if (running.has(job.id)) continue;
    const beat = job.heartbeat ?? 0;
    const ref = job.status === 'running' ? beat : Math.max(beat, job.created_at);
    if (t - ref > STALE_MS) updateJob(job.id, { status: 'paused' });
  }
  resetStaleRevisions(STALE_MS); // recover actions left mid-revise by a restart
}

function findingsText(projectId: string): string {
  return listFindings(projectId)
    .map((f) => `- [${f.category}] ${f.title}: ${f.summary ?? ''}${f.details ? ' — ' + f.details : ''}`)
    .join('\n') || '(none recorded yet)';
}

// Drive a job to completion in the background, then chain to the next phase.
async function drive(job: Job, opts: { resume?: boolean; attachments?: string[] } = {}) {
  if (running.has(job.id)) return;
  const abort = new AbortController();
  running.set(job.id, { abort, pausedByUser: false });
  updateJob(job.id, { status: 'running', error: null });
  emitEvent({ type: 'job', projectId: job.project_id, jobId: job.id });

  try {
    const fresh = getJob(job.id)!;
    const outcome = await runAgent({
      job: fresh,
      abort,
      attachments: opts.attachments,
      findingsText: job.kind === 'marketing' ? findingsText(job.project_id) : undefined,
      resumeSessionId: opts.resume ? fresh.session_id ?? undefined : undefined,
    });

    const entry = running.get(job.id);
    const pausedByUser = entry?.pausedByUser;
    running.delete(job.id);

    // Paused either via this process's abort, or via the DB flag (set by a
    // pause request that landed in a different route bundle).
    if (pausedByUser || abort.signal.aborted || getJob(job.id)?.status === 'paused') {
      updateJob(job.id, { status: 'paused' });
      emitEvent({ type: 'job', projectId: job.project_id, jobId: job.id });
      return;
    }

    // Completed normally.
    updateJob(job.id, { status: 'done', summary: outcome.finalText?.slice(0, 2000) ?? null });
    emitEvent({ type: 'job', projectId: job.project_id, jobId: job.id });

    // Research -> Marketing transition.
    if (job.kind === 'research' && getProject(job.project_id)?.phase === 'marketing') {
      const existing = listJobs(job.project_id).find((j) => j.kind === 'marketing');
      if (!existing) {
        const mkt = createJob({ project_id: job.project_id, kind: 'marketing', title: 'Active marketing — strategy & content', phase: 'marketing' });
        emitEvent({ type: 'job', projectId: job.project_id, jobId: mkt.id });
        drive(mkt); // fire and forget
      }
    }

    // Strategist -> channel specialists transition (execution swarm fan-out).
    if (job.phase === 'execution' && job.kind === 'strategist') {
      spawnSpecialists(job.project_id);
    }
  } catch (err: any) {
    running.delete(job.id);
    if (abort.signal.aborted) {
      updateJob(job.id, { status: 'paused' });
    } else {
      updateJob(job.id, { status: 'error', error: String(err?.message || err) });
    }
    emitEvent({ type: 'job', projectId: job.project_id, jobId: job.id });
  }
}

// --- public API -------------------------------------------------------------

// Create the project + its research job WITHOUT starting (lets the caller save
// attachments into the project dir first).
export function createNewProject(input: { prompt: string; url?: string; title?: string }) {
  const title = input.title || deriveTitle(input.prompt, input.url);
  const project = createProject({ title, prompt: input.prompt, url: input.url ?? null });
  emitEvent({ type: 'project', projectId: project.id });
  const job = createJob({ project_id: project.id, kind: 'research', title: 'Research — understand product, customer & market', phase: 'research' });
  emitEvent({ type: 'job', projectId: project.id, jobId: job.id });
  return { project, job };
}

export function launchJob(jobId: string, opts: { attachments?: string[] } = {}) {
  const job = getJob(jobId);
  if (job) drive(job, opts);
}

export function startProject(input: { prompt: string; url?: string; title?: string; attachments?: string[] }) {
  const { project, job } = createNewProject(input);
  drive(job, { attachments: input.attachments });
  return project;
}

export function pauseJob(jobId: string) {
  const job = getJob(jobId);
  if (!job || !['queued', 'running'].includes(job.status)) return false;
  // Write the pause to the DB first — this is what the running agent loop polls,
  // so it works even if the loop lives in a different route bundle than us.
  updateJob(jobId, { status: 'paused' });
  emitEvent({ type: 'job', projectId: job.project_id, jobId });
  // Fast-path: if the loop is in this process, abort it immediately too.
  const entry = running.get(jobId);
  if (entry) { entry.pausedByUser = true; entry.abort.abort(); }
  return true;
}

export function resumeJob(jobId: string) {
  const job = getJob(jobId);
  if (!job || running.has(jobId)) return false;
  if (!['paused', 'error', 'queued'].includes(job.status)) return false;
  drive(job, { resume: Boolean(job.session_id) });
  return true;
}

// --- execution swarm --------------------------------------------------------

const CATEGORY_ROLE: Record<string, string> = {
  organic: 'organic', community: 'organic', content: 'organic',
  email: 'email', paid: 'ads', influencer: 'influencer',
};

// Which specialist roles are implied by the campaign's selected channels.
function rolesForChannels(channelKeys: string[]): string[] {
  const roles = new Set<string>();
  for (const key of channelKeys) {
    const cat = channelDef(key).category;
    const role = CATEGORY_ROLE[cat];
    if (role) roles.add(role);
  }
  return [...roles];
}

export function launchCampaign(projectId: string, opts: { budget_cents: number; channels: string[]; autonomy?: string }) {
  const project = getProject(projectId);
  if (!project) return null;
  const campaign = createCampaign({
    project_id: projectId, budget_cents: Math.max(0, opts.budget_cents),
    channels: opts.channels, autonomy: opts.autonomy ?? 'approval',
  });
  updateProject(projectId, { phase: 'execution', status: 'active' });
  emitEvent({ type: 'project', projectId });
  const strat = createJob({ project_id: projectId, kind: 'strategist', title: ROLE_LABELS.strategist, phase: 'execution' });
  emitEvent({ type: 'job', projectId, jobId: strat.id });
  drive(strat);
  return campaign;
}

// Spawn specialist agents for the given roles. Skips a role if one already
// exists (initial fan-out) or is currently running (avoid concurrent dupes).
function spawnRoles(projectId: string, roles: string[], skipIfExisting: boolean) {
  const existing = listJobs(projectId);
  for (const role of roles) {
    const sameRole = existing.filter((j) => j.phase === 'execution' && j.kind === role);
    if (skipIfExisting && sameRole.length) continue;
    if (sameRole.some((j) => j.status === 'running' || j.status === 'queued')) continue;
    const job = createJob({ project_id: projectId, kind: role, title: ROLE_LABELS[role] || role, phase: 'execution' });
    emitEvent({ type: 'job', projectId, jobId: job.id });
    drive(job); // specialists run concurrently
  }
}

// Initial fan-out after the strategist — scoped to currently-connected channels.
function spawnSpecialists(projectId: string) {
  spawnRoles(projectId, rolesForChannels(autoChannels()), true);
}

// On-demand: generate a fresh batch of actions for the currently-connected
// channels (e.g. after the user connects a new account).
export function generateActions(projectId: string): { ok: boolean; error?: string; roles?: string[] } {
  if (!getCampaignByProject(projectId)) return { ok: false, error: 'No active campaign.' };
  const channels = autoChannels();
  if (!channels.length) return { ok: false, error: 'Connect a channel under ⚙ Channels first, then generate.' };
  const roles = rolesForChannels(channels);
  spawnRoles(projectId, roles, false);
  return { ok: true, roles };
}

// Prepare a name-matched brand account for a channel (agent does availability +
// profile kit + signup steps; the human finalizes). Lands in the action queue.
export function createAccountKit(projectId: string, channel: string): { ok: boolean; error?: string } {
  const campaign = getCampaignByProject(projectId);
  if (!campaign) return { ok: false, error: 'Launch a campaign first — account-setup tasks appear in your action queue.' };
  const abort = new AbortController();
  (async () => {
    try { await runAccountKit({ projectId, channel, abort }); } catch { /* surfaced as no new action */ }
    emitEvent({ type: 'finding', projectId });
  })();
  return { ok: true };
}

// Spin up the optimizer on demand (after some actions exist / have run).
export function launchOptimizer(projectId: string) {
  const campaign = getCampaignByProject(projectId);
  if (!campaign) return false;
  const job = createJob({ project_id: projectId, kind: 'optimizer', title: ROLE_LABELS.optimizer, phase: 'execution' });
  emitEvent({ type: 'job', projectId, jobId: job.id });
  drive(job);
  return true;
}

// Approve a proposed action: reserve budget (hard cap), then execute it via the
// best connected channel. Returns an error string if it would bust the budget.
export async function approveAction(actionId: string): Promise<{ ok: boolean; error?: string }> {
  const a = getAction(actionId);
  if (!a || a.status !== 'proposed') return { ok: false, error: 'Action is not awaiting approval.' };
  // Never let Approve produce a "now do it yourself" task: require a real executor.
  if (!isAutoExecutable(a)) {
    return { ok: false, error: a.kind === 'account'
      ? 'This is a manual account-setup task and can’t be auto-published. Connect your existing account under ⚙ Channels, then reject this.'
      : `${channelDef(a.channel).label} isn’t connected, so this can’t auto-publish. Connect it under ⚙ Channels (or reject this action).` };
  }
  if (a.cost_cents > 0 && !reserveSpend(a.campaign_id, a.cost_cents)) {
    const c = getCampaign(a.campaign_id);
    const remaining = c ? (c.budget_cents - c.spent_cents) / 100 : 0;
    return { ok: false, error: `Blocked: $${(a.cost_cents / 100).toFixed(2)} exceeds the remaining budget of $${remaining.toFixed(2)}.` };
  }
  updateAction(actionId, { status: 'approved' });
  emitEvent({ type: 'finding', projectId: a.project_id });
  // Execute asynchronously so the API call returns immediately.
  (async () => {
    const res = await runAction(getAction(actionId)!);
    if (res.status === 'failed' && a.cost_cents > 0) refundSpend(a.campaign_id, a.cost_cents);
    updateAction(actionId, { status: res.status, result: res.detail });
    emitEvent({ type: 'finding', projectId: a.project_id });
  })();
  return { ok: true };
}

// Take user feedback on a proposed action, revise its content with an agent,
// and return it to the approval queue.
export function reviseAction(actionId: string, feedback: string): boolean {
  const a = getAction(actionId);
  if (!a || !feedback.trim()) return false;
  if (!['proposed', 'ready', 'failed'].includes(a.status)) return false;
  if (a.cost_cents > 0 && a.status === 'approved') return false; // don't touch reserved/executing
  const meta = a.meta ? JSON.parse(a.meta) : {};
  meta.revisions = [...(meta.revisions || []), { feedback: feedback.trim(), ts: Date.now() }];
  updateAction(actionId, { meta: JSON.stringify(meta), status: 'revising', result: null });
  emitEvent({ type: 'finding', projectId: a.project_id });
  const abort = new AbortController();
  (async () => {
    try {
      const ok = await runRevision({ action: getAction(actionId)!, feedback: feedback.trim(), abort });
      if (!ok) updateAction(actionId, { status: 'proposed', result: 'Revision did not produce changes — please try rephrasing.' });
    } catch (err: any) {
      updateAction(actionId, { status: 'proposed', result: 'Revision error: ' + String(err?.message || err) });
    }
    emitEvent({ type: 'finding', projectId: a.project_id });
  })();
  return true;
}

export function rejectAction(actionId: string): boolean {
  const a = getAction(actionId);
  if (!a || !['proposed', 'approved', 'ready', 'failed'].includes(a.status)) return false;
  if (a.status === 'approved' && a.cost_cents > 0) refundSpend(a.campaign_id, a.cost_cents);
  updateAction(actionId, { status: 'rejected' });
  emitEvent({ type: 'finding', projectId: a.project_id });
  return true;
}

function deriveTitle(prompt: string, url?: string) {
  if (url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { /* fall through */ }
  }
  const t = prompt.trim().split('\n')[0].slice(0, 60);
  return t || 'Untitled marketing project';
}
