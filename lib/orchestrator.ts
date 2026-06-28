import {
  createProject, createJob, updateJob, getJob, getProject, updateProject, deleteProject, listJobs,
  listFindings, listAllActiveJobs, createCampaign, getCampaign, getCampaignByProject,
  updateCampaign, getAction, updateAction, reserveSpend, refundSpend, resetStaleRevisions,
  addFunds, removeFunds, setSpend, listActions, getConnector, listActiveCampaigns,
  scheduleAction, dueScheduledActions, analyzedCompetitors,
  type Job, type ActionRow, type Campaign,
} from './db';
import { emitEvent } from './events';
import { rmSync } from 'node:fs';
import { runAgent, runRevision, runAccountKit, ROLE_LABELS, projectDir } from './agent';
import { runAction, channelDef, CHANNELS, isAutoExecutable, autoChannels } from './connectors';
import { adProvider, adSecrets } from './adproviders';

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

    // Research -> Marketing transition (+ kick off competitive analysis in parallel).
    if (job.kind === 'research' && getProject(job.project_id)?.phase === 'marketing') {
      const jobs = listJobs(job.project_id);
      if (!jobs.some((j) => j.kind === 'marketing')) {
        const mkt = createJob({ project_id: job.project_id, kind: 'marketing', title: 'Active marketing — strategy & content', phase: 'marketing' });
        emitEvent({ type: 'job', projectId: job.project_id, jobId: mkt.id });
        drive(mkt); // fire and forget
      }
      if (!jobs.some((j) => j.kind === 'competitive')) {
        analyzeCompetitors(job.project_id, 5); // first competitive pass: top 5
      }
    }

    // Strategist -> channel specialists transition (execution swarm fan-out).
    if (job.phase === 'execution' && job.kind === 'strategist') {
      spawnSpecialists(job.project_id);
    }
    // Ads agent finished proposing -> release eligible ads per autonomy mode.
    if (job.phase === 'execution' && job.kind === 'ads') {
      autoApproveAds(job.project_id);
    }
    // Any specialist finished proposing -> smart-schedule new organic posts if full-auto.
    if (job.phase === 'execution' && job.kind !== 'ads') {
      scheduleProposedPosts(job.project_id);
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

// Pause/resume ALL autonomous activity for one marketing app: its campaign (so
// scheduling, refills, publishing and ad spend stop / resume) plus any in-flight
// agents. Other apps are unaffected — each campaign runs independently.
export async function setProjectPaused(projectId: string, paused: boolean): Promise<boolean> {
  if (!getProject(projectId)) return false;
  const c = getCampaignByProject(projectId);
  if (c) await setKillSwitch(projectId, paused); // campaign status + live ads + the auto loop
  if (paused) {
    for (const j of listJobs(projectId)) if (['running', 'queued'].includes(j.status)) pauseJob(j.id);
  }
  emitEvent({ type: 'project', projectId });
  return true;
}

// Permanently delete a marketing app and ALL its data: stop in-flight agents,
// wipe every DB row (connectors + cascaded jobs/findings/files/actions/campaign/
// lists/directives), and remove its working directory (PDFs, attachments).
export function removeProject(projectId: string): boolean {
  if (!getProject(projectId)) return false;
  for (const j of listJobs(projectId)) {
    const entry = running.get(j.id);
    if (entry) { entry.pausedByUser = true; entry.abort.abort(); running.delete(j.id); } // stop running agents
  }
  deleteProject(projectId);
  try { rmSync(projectDir(projectId), { recursive: true, force: true }); } catch { /* dir may not exist */ }
  emitEvent({ type: 'project', projectId });
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

export function launchCampaign(projectId: string, opts: { budget_cents: number; channels: string[]; autonomy?: string; daily_cap_cents?: number }) {
  const project = getProject(projectId);
  if (!project) return null;
  const campaign = createCampaign({
    project_id: projectId, budget_cents: Math.max(0, opts.budget_cents),
    channels: opts.channels, autonomy: opts.autonomy ?? 'approval',
    daily_cap_cents: Math.max(0, opts.daily_cap_cents ?? 0),
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
  spawnRoles(projectId, rolesForChannels(autoChannels(projectId)), true);
}

// Competitive-advantage analysis. Analyzes `count` competitors and produces a
// "Competitive Advantage Analysis" PDF. Re-runnable: each pass excludes the
// competitors already analyzed and finds `count` NEW ones. Returns the job, or
// null if one is already running.
export function analyzeCompetitors(projectId: string, count: number): Job | null {
  if (!getProject(projectId)) return null;
  if (listJobs(projectId).some((j) => j.kind === 'competitive' && (j.status === 'running' || j.status === 'queued'))) return null;
  const n = Math.max(1, Math.min(25, Math.round(count) || 5));
  const exclude = analyzedCompetitors(projectId);
  const title = exclude.length ? `Competitive analysis — ${n} more competitor${n === 1 ? '' : 's'}` : `Competitive advantage — top ${n} competitors`;
  const job = createJob({ project_id: projectId, kind: 'competitive', title, phase: 'research', params: JSON.stringify({ count: n, exclude }) });
  emitEvent({ type: 'job', projectId, jobId: job.id });
  drive(job); // fire and forget
  return job;
}

// On-demand: generate a fresh batch of actions for the currently-connected
// channels (e.g. after the user connects a new account).
export function generateActions(projectId: string): { ok: boolean; error?: string; roles?: string[] } {
  if (!getCampaignByProject(projectId)) return { ok: false, error: 'No active campaign.' };
  const channels = autoChannels(projectId);
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

// --- autonomous ad budget controls -----------------------------------------

export function addCampaignFunds(projectId: string, cents: number) {
  const c = getCampaignByProject(projectId); if (!c) return false;
  addFunds(c.id, cents); emitEvent({ type: 'project', projectId }); return true;
}
export function removeCampaignFunds(projectId: string, cents: number) {
  const c = getCampaignByProject(projectId); if (!c) return false;
  removeFunds(c.id, cents); emitEvent({ type: 'project', projectId }); return true;
}
export function setDailyCap(projectId: string, cents: number) {
  const c = getCampaignByProject(projectId); if (!c) return false;
  updateCampaign(c.id, { daily_cap_cents: Math.max(0, cents) }); emitEvent({ type: 'project', projectId }); return true;
}
export function setAutonomy(projectId: string, mode: string) {
  const c = getCampaignByProject(projectId); if (!c) return false;
  const ok = ['approval', 'auto_after_first', 'autonomous', 'optimize_only'].includes(mode);
  if (!ok) return false;
  updateCampaign(c.id, { autonomy: mode }); emitEvent({ type: 'project', projectId });
  autoApproveAds(projectId); // a more-autonomous mode may release queued ads now
  return true;
}
// Full-auto organic posting: smart-schedule + auto-publish proposed posts.
export function setAutoPosts(projectId: string, on: boolean) {
  const c = getCampaignByProject(projectId); if (!c) return false;
  updateCampaign(c.id, { auto_posts: on ? 1 : 0 });
  if (on) {
    scheduleProposedPosts(projectId); // queue everything already waiting…
    refillScheduledPosts(projectId);  // …and start generating now if the pipeline is thin
  }
  emitEvent({ type: 'project', projectId });
  return true;
}
// Kill switch: pause/resume the whole campaign (and pause live Meta entities).
export async function setKillSwitch(projectId: string, paused: boolean) {
  const c = getCampaignByProject(projectId); if (!c) return false;
  updateCampaign(c.id, { status: paused ? 'paused' : 'active' });
  if (paused) await pauseAllLiveAds(projectId, c.id);  // stop real spend immediately, every provider
  emitEvent({ type: 'project', projectId });
  if (!paused) autoApproveAds(projectId);
  return true;
}

// Pause every live ad across all providers (Meta / Google / Reddit) for a campaign.
async function pauseAllLiveAds(projectId: string, campaignId: string) {
  for (const a of listActions(campaignId).filter((x) => x.kind === 'ad' && x.status === 'done')) {
    const provider = adProvider(a.channel); if (!provider) continue;
    const s = adSecrets(projectId, a.channel); if (!s?.access_token) continue;
    const ids = parseMeta(a.meta).meta_ids;
    if (ids?.campaignId) { try { await provider.setStatus(s, ids, 'PAUSED'); } catch { /* best effort */ } }
  }
}

// Auto-approve queued ad actions per the campaign's autonomy mode + caps. The
// first ad always needs a human OK in 'auto_after_first'.
export async function autoApproveAds(projectId: string) {
  const c = getCampaignByProject(projectId);
  if (!c || c.status !== 'active' || c.autonomy === 'approval' || c.autonomy === 'optimize_only') return;
  const actions = listActions(c.id);
  let anyAdLive = actions.some((a) => a.kind === 'ad' && a.status === 'done');
  for (const a of actions) {
    if (a.kind !== 'ad' || a.status !== 'proposed') continue;
    if (c.autonomy === 'auto_after_first' && !anyAdLive) continue; // first stays manual
    const res = await approveAction(a.id);
    if (res.ok) anyAdLive = true; // unlock the rest once one is live
  }
}

// ---------------------------------------------------------------------------
// Smart organic-post scheduler (full-auto mode).
//
// Each channel has rough best-time-to-post windows (local server time), a daily
// cadence cap, and a minimum gap so the swarm can't spam a feed. Proposed posts
// are dripped into the next free slots; a background tick publishes due ones via
// the same approveAction path a human click would take. We never fabricate
// engagement and never auto-blast email (those need an explicit list).
// ---------------------------------------------------------------------------
type PostWindow = { hours: number[]; perDay: number; gapHours: number };
const DEFAULT_WINDOW: PostWindow = { hours: [9, 13, 17], perDay: 2, gapHours: 4 };
const POST_WINDOWS: Record<string, PostWindow> = {
  x:           { hours: [8, 12, 17, 20], perDay: 3, gapHours: 3 },   // higher cadence is normal on X
  linkedin:    { hours: [8, 12, 17],     perDay: 1, gapHours: 20 },  // 1/day, business hours
  reddit:      { hours: [9, 14, 19],     perDay: 1, gapHours: 22 },  // sparing — communities punish spam
  instagram:   { hours: [11, 13, 19],    perDay: 1, gapHours: 18 },
  threads:     { hours: [9, 12, 18],     perDay: 2, gapHours: 5 },
  mastodon:    { hours: [9, 13, 18],     perDay: 2, gapHours: 5 },
  facebook:    { hours: [9, 13, 19],     perDay: 1, gapHours: 18 },
  tiktok:      { hours: [11, 16, 20],    perDay: 1, gapHours: 18 },
  youtube:     { hours: [12, 17],        perDay: 1, gapHours: 22 },
  discord:     { hours: [10, 15, 20],    perDay: 2, gapHours: 4 },
  blog:        { hours: [10],            perDay: 1, gapHours: 40 },  // long-form, infrequent
  hackernews:  { hours: [9, 15],         perDay: 1, gapHours: 40 },
  producthunt: { hours: [9],             perDay: 1, gapHours: 40 },
  indiehackers:{ hours: [10, 16],        perDay: 1, gapHours: 24 },
};
const postWindow = (channel: string) => POST_WINDOWS[channel] || DEFAULT_WINDOW;

// Channels we auto-schedule: organic/community/content only (not paid ads, not
// email — those are handled elsewhere and need explicit targeting/lists).
function isAutoPostable(a: ActionRow): boolean {
  if (a.kind === 'ad') return false;
  const cat = channelDef(a.channel).category;
  if (cat !== 'organic' && cat !== 'community' && cat !== 'content') return false;
  return isAutoExecutable(a); // only schedule what we can actually publish (channel connected)
}

const startOfDay = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

// Find the next free publish time for `channel` given times already taken on it.
function nextPostSlot(channel: string, taken: number[]): number {
  const w = postWindow(channel);
  const now = Date.now();
  const sorted = [...taken].sort((a, b) => a - b);
  for (let day = 0; day < 60; day++) {
    const base = startOfDay(now) + day * 86400_000;
    const onDay = sorted.filter((t) => startOfDay(t) === base).length;
    if (onDay >= w.perDay) continue;                                        // daily cadence cap reached
    for (const h of w.hours) {
      const cand = base + h * 3600_000;
      if (cand <= now + 60_000) continue;                                   // must be in the future
      if (sorted.some((t) => Math.abs(t - cand) < w.gapHours * 3600_000)) continue; // respect min gap
      return cand;
    }
  }
  return now + 3600_000; // fallback: an hour out
}

// Queue every still-proposed organic post for the project into smart slots.
// No-op unless the campaign is in full-auto posting mode.
export function scheduleProposedPosts(projectId: string) {
  const c = getCampaignByProject(projectId);
  if (!c || c.status !== 'active' || !c.auto_posts) return;
  const actions = listActions(c.id);
  // Seed "taken" per channel with already scheduled/published posts.
  const taken: Record<string, number[]> = {};
  for (const a of actions) {
    if (!isAutoPostable(a)) continue;
    if (a.status === 'scheduled' && a.scheduled_at) (taken[a.channel] ||= []).push(a.scheduled_at);
    else if (a.status === 'done') (taken[a.channel] ||= []).push(a.updated_at);
  }
  let queued = 0;
  for (const a of actions) {
    if (a.status !== 'proposed' || !isAutoPostable(a)) continue;
    const slot = nextPostSlot(a.channel, taken[a.channel] || []);
    (taken[a.channel] ||= []).push(slot);
    scheduleAction(a.id, slot);
    queued++;
  }
  if (queued) emitEvent({ type: 'project', projectId });
}

// Publish posts whose scheduled slot has arrived. Re-checks the campaign is still
// active/full-auto (a kill switch or toggle-off cancels).
//
// Offline-catch-up: if we were down and several posts are overdue, do NOT
// burst-publish the backlog (that reads as spam and can get an account throttled).
// Publish at most the OLDEST overdue post per channel as catch-up, and re-space
// the rest into upcoming smart slots so they resume their natural cadence.
async function publishDuePosts() {
  const now = Date.now();
  const due = dueScheduledActions(now); // status='scheduled' AND scheduled_at<=now, oldest first
  if (!due.length) return;
  const caughtUp = new Set<string>();          // `${campaignId}|${channel}` already published this run
  const taken: Record<string, number[]> = {};  // same key -> times to space re-scheduled posts around
  const touched = new Set<string>();            // project ids whose queue we re-spaced
  for (const a of due) {
    const c = getCampaign(a.campaign_id);
    if (!c || c.status !== 'active' || !c.auto_posts) continue; // paused/kill-switched -> hold
    const key = `${a.campaign_id}|${a.channel}`;
    if (!caughtUp.has(key)) {
      caughtUp.add(key);
      try { await approveAction(a.id); } catch { /* leave it; retry next tick */ }
      continue;
    }
    // Backlog for this channel — push it to the next free FUTURE slot instead of
    // publishing it now, so the overdue posts drip out rather than dumping.
    if (!taken[key]) {
      taken[key] = listActions(a.campaign_id)
        .filter((x) => x.channel === a.channel && ((x.status === 'scheduled' && x.scheduled_at > now) || ['done', 'sent'].includes(x.status)))
        .map((x) => (x.status === 'scheduled' ? x.scheduled_at : x.updated_at));
      taken[key].push(now); // count the catch-up we just published
    }
    const slot = nextPostSlot(a.channel, taken[key]);
    taken[key].push(slot);
    scheduleAction(a.id, slot);
    touched.add(a.project_id);
  }
  for (const pid of touched) emitEvent({ type: 'project', projectId: pid });
}

// Keep a rolling content pipeline: when a full-auto project's upcoming post
// queue runs low (and no swarm job is mid-flight), spawn the post-producing
// specialists again so it keeps publishing over time instead of going quiet.
const MIN_QUEUED_POSTS = 6;
function refillScheduledPosts(projectId: string) {
  const c = getCampaignByProject(projectId);
  if (!c || c.status !== 'active' || !c.auto_posts) return;
  const actions = listActions(c.id);
  const queued = actions.filter((a) =>
    (a.status === 'scheduled' && a.scheduled_at > Date.now()) ||
    (a.status === 'proposed' && isAutoPostable(a))).length;
  if (queued >= MIN_QUEUED_POSTS) return;
  // Don't stack generations: skip if a specialist is already running/queued.
  if (listJobs(projectId).some((j) => j.phase === 'execution' && (j.status === 'running' || j.status === 'queued'))) return;
  // Only the post-producing channels (not ads/email) drive organic refills.
  const postChannels = autoChannels(projectId).filter((k) => ['organic', 'community', 'content'].includes(channelDef(k).category));
  if (postChannels.length) spawnRoles(projectId, rolesForChannels(postChannels), false);
}

// Background poller: sync ad spend + cap, schedule new posts, publish due posts,
// and refill the content pipeline. Runs regardless of the UI being open.
// Guarded on globalThis so only one interval runs per process.
const POLL_MS = 5 * 60 * 1000; // every 5 minutes (tighter so scheduled posts publish near their slot)
async function pollAllCampaigns() {
  for (const c of listActiveCampaigns()) {
    scheduleProposedPosts(c.project_id); // catch anything not scheduled at job-completion time
    refillScheduledPosts(c.project_id);  // top up the pipeline when it runs low
    if (listActions(c.id).some((a) => a.kind === 'ad' && a.status === 'done')) {
      try { await runAdOptimizer(c.project_id); } catch { /* keep polling others */ }
    }
  }
  await publishDuePosts();
}
{
  // Re-arm on every module load: in Next dev, HMR reloads this module but a
  // setInterval guarded on globalThis would keep firing the OLD closure (stale
  // code from before the reload). Clearing + re-creating binds the timer to the
  // current code. The interval is only a backup — autonomousTick() (below),
  // called from request paths, is the reliable driver.
  const gp = globalThis as any;
  if (gp.__adPoll) clearInterval(gp.__adPoll);
  gp.__adPoll = setInterval(() => { pollAllCampaigns().catch(() => {}); }, POLL_MS);
}

// Advance the autonomous loop for ONE project on demand. Called (fire-and-forget,
// throttled) from request paths so progress never depends on a timer surviving
// HMR/restart — consistent with the app's DB-driven, no-singleton model.
export function autonomousTick(projectId: string) {
  const c = getCampaignByProject(projectId);
  if (!c || c.status !== 'active' || !c.auto_posts) return;
  const ticks: Record<string, number> = ((globalThis as any).__autoTick ||= {});
  const now = Date.now();
  if (now - (ticks[projectId] || 0) < 45_000) return; // throttle: at most once / 45s per project
  ticks[projectId] = now;
  scheduleProposedPosts(projectId);  // queue any proposed posts for connected channels
  refillScheduledPosts(projectId);   // generate fresh posts if the pipeline is thin
  publishDuePosts().catch(() => {});  // publish anything whose slot has arrived
}

// Performance thresholds for auto-pausing a losing ad. Conservative: an ad gets
// a fair test (min spend + min impressions) before judgement, so we don't kill
// it on noise. Tunable in one place.
const AD_MIN_SPEND_CENTS = 500;     // don't judge an ad under ~$5 of spend
const AD_MIN_IMPRESSIONS = 800;     // …or under this much reach
const AD_CTR_FLOOR = 0.004;         // < 0.4% click-through = underperforming
const AD_DEAD_SPEND_CENTS = 1500;   // ≥ $15 spent with zero clicks = dead, pause regardless

// Pull real spend + per-ad performance from Meta, update the ledger, hard-stop
// at the cap, and (unless in manual 'approval' mode) auto-pause ads that have
// had a fair test but are clearly underperforming. Safe to call on a schedule.
export type AdSyncResult = { ok: boolean; liveAds: number; synced: number; spentCents: number; issues: string[] };
export async function runAdOptimizer(projectId: string): Promise<AdSyncResult> {
  const c = getCampaignByProject(projectId);
  if (!c) return { ok: false, liveAds: 0, synced: 0, spentCents: 0, issues: ['No campaign.'] };
  const optimize = c.autonomy !== 'approval'; // manual mode still gets cap-safety, just no auto-pause
  const liveAds = listActions(c.id).filter((x) => x.kind === 'ad' && x.status === 'done');
  const issues: string[] = [];
  if (!liveAds.length) { emitEvent({ type: 'project', projectId }); return { ok: true, liveAds: 0, synced: 0, spentCents: c.spent_cents, issues }; }
  let total = 0;
  let synced = 0;
  const disconnected = new Set<string>();
  for (const a of liveAds) {
    const provider = adProvider(a.channel);
    if (!provider) continue;
    const s = adSecrets(projectId, a.channel);
    if (!s?.access_token) { disconnected.add(channelDef(a.channel).label); continue; } // can't reach the platform
    const m = parseMeta(a.meta);
    const ids = m.meta_ids;
    if (!ids?.campaignId) continue;
    let ins;
    try { ins = await provider.insights(s, ids); }
    catch (e: any) { issues.push(`${channelDef(a.channel).label}: ${String(e?.message || e).slice(0, 200)}`); continue; }
    synced++;
    total += ins.spendCents;
    if (m.ad_paused) continue; // already off — counted for spend, skip judgement
    // Evaluate this ad. CTR = clicks / impressions.
    const ctr = ins.impressions > 0 ? ins.clicks / ins.impressions : 0;
    const dead = ins.spendCents >= AD_DEAD_SPEND_CENTS && ins.clicks === 0;
    const weak = ins.spendCents >= AD_MIN_SPEND_CENTS && ins.impressions >= AD_MIN_IMPRESSIONS && ctr < AD_CTR_FLOOR;
    if (optimize && (dead || weak)) {
      const why = dead
        ? `Auto-paused: spent $${(ins.spendCents / 100).toFixed(2)} with 0 clicks.`
        : `Auto-paused: CTR ${(ctr * 100).toFixed(2)}% below ${(AD_CTR_FLOOR * 100).toFixed(1)}% floor after ${ins.impressions.toLocaleString()} impressions ($${(ins.spendCents / 100).toFixed(2)} spent).`;
      try {
        await provider.setStatus(s, ids, 'PAUSED');
        updateAction(a.id, { meta: JSON.stringify({ ...m, ad_paused: true, paused_reason: why }), result: why });
      } catch { /* try again next cycle */ }
    } else {
      // Keep a fresh performance snapshot on the action for the UI.
      const perf = { spend_cents: ins.spendCents, impressions: ins.impressions, clicks: ins.clicks, ctr };
      if (JSON.stringify(m.perf) !== JSON.stringify(perf)) updateAction(a.id, { meta: JSON.stringify({ ...m, perf }) });
    }
  }
  if (synced > 0) {
    setSpend(c.id, total);
    if (c.budget_cents > 0 && total >= c.budget_cents) await setKillSwitch(projectId, true); // hard stop at the cap
  }
  if (disconnected.size) issues.unshift(`${[...disconnected].join(', ')} ${disconnected.size === 1 ? 'is' : 'are'} not connected — reconnect under ⚙ Channels to sync real spend.`);
  emitEvent({ type: 'project', projectId });
  return { ok: synced > 0 || liveAds.length === 0, liveAds: liveAds.length, synced, spentCents: synced > 0 ? total : c.spent_cents, issues };
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
export async function approveAction(actionId: string, opts: { list_id?: string } = {}): Promise<{ ok: boolean; error?: string; status?: string; detail?: string }> {
  let a = getAction(actionId);
  if (!a || !['proposed', 'scheduled', 'failed'].includes(a.status)) return { ok: false, error: 'Action is not awaiting approval.' };
  // Attach the chosen email list before sending.
  if (opts.list_id) {
    const meta = a.meta ? JSON.parse(a.meta) : {};
    meta.list_id = opts.list_id;
    updateAction(actionId, { meta: JSON.stringify(meta) });
    a = getAction(actionId)!;
  }
  // Email/outreach must target a recipient list (or explicit recipients).
  if (['email', 'outreach'].includes(a.kind)) {
    const meta = a.meta ? JSON.parse(a.meta) : {};
    if (!meta.list_id && !meta.to && !meta.recipients) {
      return { ok: false, error: 'Pick an email list to send to (or add recipients) before approving.' };
    }
  }
  // Never let Approve produce a "now do it yourself" task: require a real executor.
  if (!isAutoExecutable(a)) {
    return { ok: false, error: a.kind === 'account'
      ? 'This is a manual account-setup task and can’t be auto-published. Connect your existing account under ⚙ Channels, then reject this.'
      : `${channelDef(a.channel).label} isn’t connected, so this can’t auto-publish. Connect it under ⚙ Channels (or reject this action).` };
  }
  // Guard: don't publish a video script / storyboard as a text post. Record the
  // reason on the action so it's visible inline (not just a transient banner).
  const SCRIPT_MARKERS = /on-screen text:|voice ?over|\bVO:|b-roll|\*\*format:?\*\*|hook \(0|talking-to-camera|\b9:16\b|\(\d\/\d\)/i;
  const textChannel = ['x', 'mastodon', 'threads', 'linkedin', 'reddit'].includes(a.channel);
  if (textChannel && a.content && SCRIPT_MARKERS.test(a.content)) {
    const msg = 'This reads like a video script, not a ready-to-post message. Use the feedback box (e.g. “rewrite as a natural tweet thread, no stage directions”), then approve.';
    updateAction(actionId, { result: msg });
    emitEvent({ type: 'finding', projectId: a.project_id });
    return { ok: false, error: msg };
  }
  const c = getCampaign(a.campaign_id);
  if (a.kind === 'ad') {
    // Ad spend: enforce kill switch + total cap + daily cap (no reserve — spend
    // accrues from platform insights over time).
    const block = adSpendBlock(c, a.cost_cents);
    if (block) { updateAction(actionId, { result: block }); emitEvent({ type: 'finding', projectId: a.project_id }); return { ok: false, error: block }; }
  } else if (a.cost_cents > 0 && !reserveSpend(a.campaign_id, a.cost_cents)) {
    const remaining = c ? (c.budget_cents - c.spent_cents) / 100 : 0;
    const msg = `Blocked: $${(a.cost_cents / 100).toFixed(2)} exceeds the remaining budget of $${remaining.toFixed(2)}.`;
    updateAction(actionId, { result: msg });
    emitEvent({ type: 'finding', projectId: a.project_id });
    return { ok: false, error: msg };
  }
  updateAction(actionId, { status: 'approved' });
  emitEvent({ type: 'finding', projectId: a.project_id });
  // Await execution so the caller gets real success/failure feedback (+ the link).
  const res = await runAction(getAction(actionId)!);
  if (res.status === 'failed' && a.kind !== 'ad' && a.cost_cents > 0) refundSpend(a.campaign_id, a.cost_cents);
  const patch: any = { status: res.status, result: res.detail };
  if (res.store) { const meta = a.meta ? JSON.parse(a.meta) : {}; patch.meta = JSON.stringify({ ...meta, ...res.store }); }
  updateAction(actionId, patch);
  emitEvent({ type: 'finding', projectId: a.project_id });
  // Publishing a post (manual "Publish now" or auto) drains the queue — keep the
  // full-auto pipeline topped up so new posts get scheduled to replace it.
  if (res.status !== 'failed' && a.kind !== 'ad' && getCampaign(a.campaign_id)?.auto_posts) {
    scheduleProposedPosts(a.project_id);
    refillScheduledPosts(a.project_id);
  }
  return { ok: true, status: res.status, detail: res.detail };
}

const parseMeta = (m: string | null) => { try { return m ? JSON.parse(m) : {}; } catch { return {}; } };

// Sum of the daily budgets of currently-live (not paused) ad actions.
export function committedDailyCents(campaignId: string): number {
  return listActions(campaignId)
    .filter((x) => x.kind === 'ad' && x.status === 'done' && !parseMeta(x.meta).ad_paused)
    .reduce((s, x) => s + x.cost_cents, 0);
}

// Per-ad controls (each ad action = its own platform campaign on its channel).
export async function pauseAd(actionId: string): Promise<{ ok: boolean; error?: string }> {
  const a = getAction(actionId);
  if (!a || a.kind !== 'ad' || a.status !== 'done') return { ok: false, error: 'Not a live ad.' };
  const meta = parseMeta(a.meta); const provider = adProvider(a.channel); const s = adSecrets(a.project_id, a.channel);
  if (provider && s?.access_token && meta.meta_ids?.campaignId) {
    try { await provider.setStatus(s, meta.meta_ids, 'PAUSED'); }
    catch (e: any) { return { ok: false, error: String(e?.message || e) }; }
  }
  updateAction(actionId, { meta: JSON.stringify({ ...meta, ad_paused: true }) });
  emitEvent({ type: 'finding', projectId: a.project_id });
  return { ok: true };
}
export async function resumeAd(actionId: string): Promise<{ ok: boolean; error?: string }> {
  const a = getAction(actionId);
  if (!a || a.kind !== 'ad' || a.status !== 'done') return { ok: false, error: 'Not a paused ad.' };
  const block = adSpendBlock(getCampaign(a.campaign_id), a.cost_cents);
  if (block) return { ok: false, error: block };
  const meta = parseMeta(a.meta); const provider = adProvider(a.channel); const s = adSecrets(a.project_id, a.channel);
  if (provider && s?.access_token && meta.meta_ids) {
    try { await provider.setStatus(s, meta.meta_ids, 'ACTIVE'); }
    catch (e: any) { return { ok: false, error: String(e?.message || e) }; }
  }
  updateAction(actionId, { meta: JSON.stringify({ ...meta, ad_paused: false }) });
  emitEvent({ type: 'finding', projectId: a.project_id });
  return { ok: true };
}
export async function removeAd(actionId: string): Promise<{ ok: boolean; error?: string }> {
  const a = getAction(actionId);
  if (!a || a.kind !== 'ad') return { ok: false, error: 'Not an ad.' };
  const meta = parseMeta(a.meta); const provider = adProvider(a.channel); const s = adSecrets(a.project_id, a.channel);
  if (provider && s?.access_token && meta.meta_ids?.campaignId) {
    try { await provider.remove(s, meta.meta_ids); } catch { /* best effort */ }
  }
  updateAction(actionId, { status: 'rejected', result: `Ad removed from ${channelDef(a.channel).label}.` });
  emitEvent({ type: 'finding', projectId: a.project_id });
  return { ok: true };
}
// Returns a block reason if this ad spend isn't allowed, else ''.
function adSpendBlock(c: Campaign | undefined, dailyCents: number): string {
  if (!c) return 'No campaign.';
  if (c.status === 'paused') return 'Campaign is paused (kill switch on). Resume it to launch ads.';
  if (c.budget_cents > 0 && c.spent_cents >= c.budget_cents) return 'Total ad budget reached. Add funds to launch more.';
  if (c.daily_cap_cents > 0) {
    const committed = committedDailyCents(c.id);
    if (committed + dailyCents > c.daily_cap_cents) {
      return `Daily cap $${(c.daily_cap_cents / 100).toFixed(2)} would be exceeded ($${(committed / 100).toFixed(2)} already committed + $${(dailyCents / 100).toFixed(2)}). Raise the daily cap or pause a live ad.`;
    }
  }
  return '';
}

// Take user feedback on a proposed action, revise its content with an agent,
// and return it to the approval queue.
export function reviseAction(actionId: string, feedback: string): boolean {
  const a = getAction(actionId);
  if (!a || !feedback.trim()) return false;
  if (!['proposed', 'scheduled', 'ready', 'failed'].includes(a.status)) return false;
  if (a.cost_cents > 0 && a.status === 'approved') return false; // don't touch reserved/executing
  // A scheduled post keeps its slot through the revision (re-publishing as 'scheduled').
  const revertStatus = a.status === 'scheduled' ? 'scheduled' : 'proposed';
  const meta = a.meta ? JSON.parse(a.meta) : {};
  meta.revisions = [...(meta.revisions || []), { feedback: feedback.trim(), ts: Date.now() }];
  updateAction(actionId, { meta: JSON.stringify(meta), status: 'revising', result: null });
  emitEvent({ type: 'finding', projectId: a.project_id });
  const abort = new AbortController();
  (async () => {
    try {
      const ok = await runRevision({ action: getAction(actionId)!, feedback: feedback.trim(), abort });
      if (!ok) updateAction(actionId, { status: revertStatus, result: 'Revision did not produce changes — please try rephrasing.' });
    } catch (err: any) {
      updateAction(actionId, { status: revertStatus, result: 'Revision error: ' + String(err?.message || err) });
    }
    emitEvent({ type: 'finding', projectId: a.project_id });
  })();
  return true;
}

export function rejectAction(actionId: string): boolean {
  const a = getAction(actionId);
  if (!a || !['proposed', 'scheduled', 'approved', 'ready', 'failed'].includes(a.status)) return false;
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
