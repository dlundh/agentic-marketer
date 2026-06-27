import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import {
  DATA_DIR, uid, addActivity, addFinding, addFile, updateJob, updateProject,
  getProject, getJob, touchJob, getCampaignByProject, updateCampaign, createAction,
  getAction, updateAction, listFindings, directivesText, type Job, type Project, type ActionRow,
} from './db';
import { emitEvent } from './events';
import { renderPdf, type PdfSection } from './pdf';
import { channelDef, CHANNELS, autoChannels } from './connectors';
import { listActions } from './db';

export function projectDir(projectId: string) {
  const dir = path.join(DATA_DIR, 'projects', projectId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Per-run scratch state so the orchestrator can react after the loop ends.
export type RunOutcome = {
  researchComplete: boolean;
  marketingComplete: boolean;
  sessionId?: string;
  finalText?: string;
};

function log(job: Job, kind: string, label?: string, content?: string) {
  const a = addActivity({ job_id: job.id, project_id: job.project_id, kind, label, content });
  emitEvent({ type: 'activity', projectId: job.project_id, jobId: job.id, activity: a });
}

// Build the in-process tool server, closured over the current job/project.
function buildTools(job: Job, outcome: RunOutcome) {
  const projectId = job.project_id;

  const saveFinding = tool(
    'save_finding',
    'Record a concrete research finding (a fact you learned about the product, its market, competitors, or the ideal customer). Call this often as you learn things.',
    {
      category: z.enum(['product', 'audience', 'market', 'competitor', 'positioning', 'channel', 'other'])
        .describe('What this finding is about'),
      title: z.string().describe('Short headline for the finding'),
      summary: z.string().describe('1-2 sentence summary'),
      details: z.string().optional().describe('Supporting detail, evidence, sources'),
    },
    async (args) => {
      addFinding({ project_id: projectId, job_id: job.id, ...args });
      log(job, 'finding', `${args.category}: ${args.title}`, args.summary);
      emitEvent({ type: 'finding', projectId, jobId: job.id });
      return { content: [{ type: 'text', text: `Saved finding "${args.title}".` }] };
    },
  );

  const createPdf = tool(
    'create_pdf_report',
    'Generate a downloadable PDF report (e.g. a market analysis, customer profile, or marketing plan). Use this to deliver polished deliverables to the user.',
    {
      title: z.string().describe('Report title'),
      subtitle: z.string().optional(),
      sections: z.array(z.object({
        heading: z.string(),
        body: z.string().describe('Prose for this section'),
        bullets: z.array(z.string()).optional(),
      })).min(1).describe('Ordered sections of the report'),
    },
    async (args) => {
      const fileId = uid('file_');
      const out = await renderPdf(
        { title: args.title, subtitle: args.subtitle, sections: args.sections as PdfSection[] },
        fileId,
      );
      const f = addFile({
        project_id: projectId, job_id: job.id, name: out.name, path: out.path,
        mime: 'application/pdf', size: out.size, kind: 'report',
      });
      log(job, 'file', `Report: ${args.title}`, out.name);
      emitEvent({ type: 'file', projectId, jobId: job.id, file: f });
      return { content: [{ type: 'text', text: `Created PDF "${out.name}" (${out.size} bytes). It is now available to the user for download.` }] };
    },
  );

  const markResearchComplete = tool(
    'mark_research_complete',
    'Call this ONCE when you have gathered enough research to confidently describe the product, its ideal customer, and the target market. This signals the service to move on to active marketing.',
    {
      ideal_customer: z.string().describe('Concise profile of the perfect customer'),
      target_market: z.string().describe('The market/segment to go after'),
      summary: z.string().describe('Overall summary of what was learned'),
    },
    async (args) => {
      outcome.researchComplete = true;
      addFinding({ project_id: projectId, job_id: job.id, category: 'audience', title: 'Ideal customer', summary: args.ideal_customer });
      addFinding({ project_id: projectId, job_id: job.id, category: 'market', title: 'Target market', summary: args.target_market });
      updateProject(projectId, { summary: args.summary, phase: 'marketing' });
      log(job, 'status', 'Research complete', args.summary);
      emitEvent({ type: 'project', projectId });
      return { content: [{ type: 'text', text: 'Research phase marked complete. The marketing phase will begin.' }] };
    },
  );

  const markMarketingComplete = tool(
    'mark_marketing_complete',
    'Call this when you have produced a complete marketing strategy and the key marketing deliverables (plan, messaging, channel recommendations, sample content) as PDFs.',
    {
      summary: z.string().describe('Summary of the marketing approach delivered'),
    },
    async (args) => {
      outcome.marketingComplete = true;
      updateProject(projectId, { summary: args.summary, phase: 'done', status: 'done' });
      log(job, 'status', 'Marketing plan delivered', args.summary);
      emitEvent({ type: 'project', projectId });
      return { content: [{ type: 'text', text: 'Marketing deliverables recorded.' }] };
    },
  );

  // --- execution-phase tools ---

  const checkBudget = tool(
    'check_budget',
    'Check the campaign budget before proposing anything that costs money. Returns the hard cap, what is already committed, and what remains.',
    {},
    async () => {
      const c = getCampaignByProject(projectId);
      if (!c) return { content: [{ type: 'text', text: 'No active campaign.' }] };
      const d = (n: number) => (n / 100).toFixed(2);
      return { content: [{ type: 'text', text: JSON.stringify({
        currency: c.currency, budget: `$${d(c.budget_cents)}`, spent_committed: `$${d(c.spent_cents)}`,
        remaining: `$${d(c.budget_cents - c.spent_cents)}`, autonomy: c.autonomy,
      }) }] };
    },
  );

  const proposeAction = tool(
    'propose_action',
    'Propose ONE concrete marketing action for human approval (nothing is published or spent until the user approves). Write real, ready-to-publish copy in `content`.',
    {
      channel: z.string().describe('Channel key, e.g. x, linkedin, reddit, producthunt, hackernews, email, influencer, meta_ads, google_ads, blog'),
      kind: z.enum(['post', 'thread', 'ad', 'email', 'outreach', 'experiment', 'asset', 'seo', 'video']).describe('Type of action'),
      title: z.string().describe('Short label for the queue'),
      summary: z.string().describe('One line: what this does and why'),
      content: z.string().describe('The actual ready-to-publish copy / script / ad text'),
      cost_usd: z.number().default(0).describe('Estimated spend in USD if executed (0 for organic)'),
      recipients: z.array(z.string()).optional().describe('Email recipients (only if the user already provided them; never invent addresses)'),
      subject: z.string().optional().describe('Email subject line'),
      targeting: z.string().optional().describe('Audience / targeting / community + posting norms'),
      schedule: z.string().optional().describe('When to publish (e.g. "Tue 9am", "launch day")'),
      rationale: z.string().optional().describe('Why this is high-leverage for the budget'),
      image_url: z.string().optional().describe('REQUIRED for ads: a public image URL for the creative (app icon, screenshot, or site OG image). Meta ads fail without one.'),
      headline: z.string().optional().describe('Short ad headline (for ads)'),
      link: z.string().optional().describe('Destination URL for ads (defaults to the product URL)'),
    },
    async (args) => {
      const c = getCampaignByProject(projectId);
      if (!c) return { content: [{ type: 'text', text: 'No active campaign — cannot propose.' }], isError: true };
      const cost = Math.max(0, Math.round((args.cost_usd || 0) * 100));
      const remaining = c.budget_cents - c.spent_cents;
      const overBudget = cost > remaining;
      const a = createAction({
        project_id: projectId, campaign_id: c.id, job_id: job.id,
        channel: args.channel, kind: args.kind, title: args.title, summary: args.summary,
        content: args.content, cost_cents: cost,
        meta: { recipients: args.recipients, subject: args.subject, targeting: args.targeting,
                schedule: args.schedule, rationale: args.rationale, overBudget,
                image_url: args.image_url, headline: args.headline, link: args.link },
      });
      log(job, 'action', `${channelDef(args.channel).label} · ${args.kind}${cost ? ` · $${(cost / 100).toFixed(2)}` : ''}`, args.title);
      emitEvent({ type: 'finding', projectId, jobId: job.id });
      const warn = overBudget ? ` WARNING: $${(cost / 100).toFixed(2)} exceeds remaining $${(remaining / 100).toFixed(2)} — it will be blocked at approval. Lower the cost or find a free alternative.` : '';
      return { content: [{ type: 'text', text: `Queued "${args.title}" for approval (id ${a.id}).${warn}` }] };
    },
  );

  const setStrategy = tool(
    'set_strategy',
    'Record the overall execution strategy and how the budget is allocated across channels. Call once.',
    {
      strategy: z.string().describe('The execution thesis: where to focus and why, given the budget'),
      allocations: z.array(z.object({
        channel: z.string(), budget_usd: z.number(), rationale: z.string().optional(),
      })).describe('Budget split across channels (use 0 for organic-only at zero budget)'),
    },
    async (args) => {
      const c = getCampaignByProject(projectId);
      if (c) updateCampaign(c.id, { strategy: args.strategy });
      addFinding({ project_id: projectId, job_id: job.id, category: 'channel', title: 'Budget allocation & strategy',
        summary: args.strategy,
        details: args.allocations.map((a) => `${channelDef(a.channel).label}: $${a.budget_usd}${a.rationale ? ` — ${a.rationale}` : ''}`).join('\n') });
      log(job, 'status', 'Strategy set', args.strategy.slice(0, 140));
      emitEvent({ type: 'finding', projectId, jobId: job.id });
      return { content: [{ type: 'text', text: 'Strategy and allocations recorded.' }] };
    },
  );

  return createSdkMcpServer({
    name: 'marketer',
    version: '1.0.0',
    tools: [saveFinding, createPdf, markResearchComplete, markMarketingComplete, checkBudget, proposeAction, setStrategy],
  });
}

const TOOL_PREFIX = 'mcp__marketer__';
const T = (n: string) => `${TOOL_PREFIX}${n}`;
const RESEARCH_TOOLS = [T('save_finding'), T('create_pdf_report'), T('mark_research_complete')];
const MARKETING_TOOLS = [T('save_finding'), T('create_pdf_report'), T('mark_marketing_complete')];
const EXEC_TOOLS = [T('save_finding'), T('create_pdf_report'), T('check_budget'), T('propose_action'), T('set_strategy')];

// User's steering guidance, injected into every agent prompt so it shapes the
// whole approach. Empty string when there's none.
function directionBlock(projectId: string): string {
  const t = directivesText(projectId);
  return t ? `\nUSER DIRECTION — overriding guidance from the human; weave this into everything you decide and produce:\n${t}\n` : '';
}

function researchPrompt(p: Project, attachments: string[]): string {
  return [
    `You are an autonomous market-research agent for a product/service marketing platform.`,
    directionBlock(p.id),
    ``,
    `THE USER WANTS TO MARKET THE FOLLOWING:`,
    p.prompt,
    p.url ? `\nPrimary URL: ${p.url}` : '',
    attachments.length ? `\nAttached reference files (read them with the Read tool): ${attachments.join(', ')}` : '',
    ``,
    `YOUR JOB (research phase):`,
    `1. Use WebSearch and WebFetch to deeply understand this product/service: what it does, its features, pricing, category, and how it is positioned. If a URL was given, fetch and study it.`,
    `2. Identify competitors and how this offering compares.`,
    `3. Determine the PERFECT customer (demographics, role, pains, motivations) and the best TARGET MARKET/segment.`,
    `4. Identify the most promising marketing channels for reaching that customer.`,
    `5. As you learn each concrete fact, call save_finding so your progress is visible to the user.`,
    `6. Produce a polished "Market & Audience Analysis" PDF using create_pdf_report with clear sections (Product Overview, Ideal Customer Profile, Target Market, Competitive Landscape, Recommended Channels, Key Insights).`,
    `7. When you are confident you understand the product, customer, and market, call mark_research_complete.`,
    ``,
    `Be thorough but efficient. Prefer real evidence from the web over speculation. Narrate your reasoning briefly as you go.`,
  ].filter(Boolean).join('\n');
}

function marketingPrompt(p: Project, findings: string): string {
  return [
    `You are an autonomous marketing strategist. Research on this product/service is complete.`,
    directionBlock(p.id),
    ``,
    `PRODUCT/SERVICE: ${p.prompt}`,
    p.url ? `URL: ${p.url}` : '',
    ``,
    `RESEARCH FINDINGS SO FAR:`,
    findings,
    ``,
    `YOUR JOB (marketing phase):`,
    `1. Based on the research, design the best marketing approach for this product and its ideal customer.`,
    `2. Use WebSearch to validate channel/tactic choices and find current best practices where useful.`,
    `3. Produce a "Go-To-Market & Marketing Plan" PDF (create_pdf_report) covering: Positioning & Messaging, Audience & Channels, Campaign Plan (with phases), Sample Content (ad copy, social posts, email subject lines), and KPIs to track.`,
    `4. Optionally produce a separate "Ready-to-Use Content Pack" PDF with concrete copy the user can use immediately.`,
    `5. Record key strategic decisions with save_finding (category "positioning" or "channel").`,
    `6. When the plan and deliverables are complete, call mark_marketing_complete.`,
    ``,
    `Make the deliverables specific and actionable for THIS product, not generic.`,
  ].filter(Boolean).join('\n');
}

// --- execution swarm -------------------------------------------------------

// Which channel categories each swarm role works across.
export const ROLE_CATEGORIES: Record<string, string[]> = {
  strategist: ['organic', 'community', 'content', 'email', 'paid', 'influencer', 'automation'],
  organic: ['organic', 'community', 'content'],
  email: ['email'],
  ads: ['paid'],
  influencer: ['influencer'],
  optimizer: ['organic', 'community', 'content', 'email', 'paid', 'influencer'],
};
export const ROLE_LABELS: Record<string, string> = {
  strategist: 'Growth strategist — budget allocation & plan',
  organic: 'Organic & community growth',
  email: 'Email & direct outreach',
  ads: 'Paid advertising',
  influencer: 'Influencer & creator outreach',
  optimizer: 'Optimizer — review & double-down',
};

function tacticsPolicy(p: Project, budgetLine: string): string {
  return [
    `You are one agent in a budget-aware growth-marketing SWARM executing the plan for this product:`,
    `${p.prompt}${p.url ? ` (${p.url})` : ''}`,
    ``,
    `OPERATING RULES (non-negotiable):`,
    `• APPROVAL-GATED: You PROPOSE actions with propose_action. Nothing is published or charged until a human approves it. Never claim you have already posted, sent, or spent anything.`,
    `• BUDGET: ${budgetLine} Call check_budget before proposing anything with a cost. Never let your proposed paid spend exceed the remaining budget. If the budget is $0, be relentlessly resourceful with free tactics; for paid channels, hunt for free ad credits/coupons and propose $0 or near-zero experiments.`,
    `• MAXIMIZE TRACTION PER DOLLAR with ingenious, high-leverage tactics tailored to THIS product's ideal customer.`,
    `• ETHICS (hard limits): no spam, no fake accounts/followers/engagement, no fake reviews, no astroturfing, no bots that break platform ToS, no deceptive or misleading claims, no purchased email lists. Everything must be genuine and respect the audience. If a tactic would annoy people or risk an account ban, DO NOT propose it. Email must be opt-in friendly with a clear opt-out (CAN-SPAM/GDPR).`,
    `• CHANNEL-NATIVE & READY-TO-POST: each action's \`content\` must be EXACTLY what should appear on that channel, posted as-is. This is critical:`,
    `   – X / Twitter / Mastodon / Threads: write a real tweet, or a real tweet-thread where each idea is a natural tweet. Conversational and human. NO stage directions, NO production notes (no "Format:", "On-screen text:", "VO:", "B-roll", "HOOK (0–3s)"), and NO manual "(1/6)" numbering — threads are split automatically.`,
    `   – Reddit: a genuine post (clear title + body) that respects the subreddit's norms; not an ad.`,
    `   – A short-form VIDEO script/storyboard is a different deliverable and is NOT a text post. Only create one if a video channel (TikTok/YouTube) is connected; never post a script as an X/Mastodon/Reddit text post.`,
    `   – If you wouldn't be proud to see it on the brand's own feed verbatim, rewrite it.`,
    `• HASHTAGS (always automatic — never ask the user): ALWAYS include a small set (about 2–4) of relevant, targeted hashtags on every X, Mastodon, Threads, Instagram and TikTok post by default — mix niche tags (e.g. #unsignedartist, #indiemusic) with a broader-reach one. On a thread, put the hashtags on the final tweet. Never hashtag-stuff (no walls of 10+). If the user specified particular hashtags, use those. Reddit and Hacker News: NO hashtags (they read as spam there).`,
  ].join('\n');
}

function executionPrompt(p: Project, role: string, budgetLine: string, channelLabels: string, findings: string, existing: string[] = []): string {
  const head = tacticsPolicy(p, budgetLine);
  const scopeLine = channelLabels
    ? `CONNECTED CHANNELS — you may ONLY propose actions for these (every action must be auto-publishable): ${channelLabels}. Never propose for any channel not in this list.`
    : `No channels in your area are connected yet, so nothing you propose could be published. Do NOT propose any actions — instead state briefly that the user should connect a channel under "⚙ Channels" to enable this.`;
  const dupeLine = existing.length ? `\nThese actions already exist — propose NEW, materially different ones, do not repeat them: ${existing.slice(0, 40).join(' | ')}.` : '';
  const ctx = `${directionBlock(p.id)}\nRESEARCH & PLAN CONTEXT:\n${findings}\n${p.summary ? `\nOverall strategy: ${p.summary}` : ''}\n\n${scopeLine}${dupeLine}\n`;
  const jobByRole: Record<string, string> = {
    strategist: [
      `YOUR ROLE — Growth Strategist:`,
      `1. Decide where to concentrate effort to get maximum traction for the budget, then call set_strategy with the thesis and a per-channel budget allocation.`,
      `2. Propose 2–4 flagship, cross-channel actions that set up the campaign (e.g. launch sequencing, a hero asset, a referral/waitlist loop) via propose_action.`,
      `Keep it sharp; the channel specialists will propose the bulk of the actions next.`,
    ].join('\n'),
    organic: [
      `YOUR ROLE — Organic & Community Growth (cost $0):`,
      `Propose a concrete batch of organic actions ONLY for your connected in-scope channels, with content written natively for each (see the channel-native rule above). For X/Mastodon: punchy real tweets and tweet-threads. For Reddit: genuine value-first posts that fit the subreddit.`,
      `Do NOT propose video scripts, storyboards, or anything with stage directions as text posts. Only include a short-form video script if a video channel is connected.`,
      `Each via propose_action with real, ready-to-post copy (kind "post" or "thread" for X/Mastodon). cost_usd = 0.`,
    ].join('\n'),
    email: [
      `YOUR ROLE — Email & Direct Outreach:`,
      `Define the target personas/segments, then propose a 2–3 step warm/cold outreach sequence and the key lifecycle emails. Use propose_action with kind "email"/"outreach", put the subject line in \`subject\` and ready-to-send copy in \`content\`. Describe WHO to target in \`targeting\`.`,
      `PERSONALIZATION (required): write each email as a template using these merge tokens, which the app fills per recipient from the user's list — do NOT hardcode names or invent addresses:`,
      `  • Greeting: open with "Hi {{first_name}}," (use {{name}} only if a full name reads better).`,
      `  • Use {{company}} where referencing the recipient's company/label is natural; {{email}} is also available.`,
      `Keep tokens to those four. Leave recipients empty — the user picks a list at approval. Keep it opt-in friendly.`,
    ].join('\n'),
    ads: [
      `YOUR ROLE — Paid Advertising (strictly budget-bound):`,
      `Call check_budget first. Design paid experiments for your in-scope channels that fit the remaining budget. If budget is low/zero, first search the web for current free ad credits/coupons (Google Ads, Microsoft Advertising, Meta, etc.) and propose $0 or minimal-cost tests. For each experiment use propose_action kind "ad" with the hook + primary text in \`content\`, audience in \`targeting\`, and a realistic cost_usd (this is the DAILY budget for the ad).`,
      `EVERY ad MUST include: a short \`headline\`, a destination \`link\`, and an \`image_url\` — a PUBLIC image for the creative. Use WebFetch on the product page to find a real image URL (app icon, screenshot, or OG image); Meta ads FAIL to launch without an image. For \`link\`, use a WEBSITE landing page — NOT an App Store / Google Play URL (Meta only allows app-store links with its App Installs objective). The SUM of your proposed daily ad budgets must stay within the remaining budget.`,
    ].join('\n'),
    influencer: [
      `YOUR ROLE — Influencer & Creator Outreach:`,
      `Use web search to identify 5–10 relevant micro/nano-creator archetypes and example creators/communities for this product. For each, propose_action with kind "outreach", channel "influencer", a pitch in \`content\`, and a fair UGC/affiliate offer that fits the budget. No payment promises beyond budget.`,
      `These send through the email pipeline to a recipient list, so TEMPLATE the pitch with merge tokens (filled per recipient): open with "Hi {{first_name}}," and use {{company}} where natural. Do NOT hardcode a specific creator's name. Leave recipients empty — the user picks a list at approval.`,
    ].join('\n'),
    optimizer: [
      `YOUR ROLE — Optimizer:`,
      `Review the proposed and executed actions and any results. Propose improvements, sharper variants, and 2–3 new high-leverage experiments. Recommend what to scale and what to cut, all within budget.`,
    ].join('\n'),
  };
  return `${head}\n${ctx}\n${jobByRole[role] || jobByRole.organic}\n\nWork efficiently and propose a solid batch, then stop.`;
}

export type RunArgs = {
  job: Job;
  attachments?: string[];
  findingsText?: string;
  resumeSessionId?: string;
  abort: AbortController;
};

// Stream a single agent run, persisting activity as it goes. Returns the outcome.
export async function runAgent(args: RunArgs): Promise<RunOutcome> {
  const { job, abort } = args;
  const project = getProject(job.project_id)!;
  const outcome: RunOutcome = { researchComplete: false, marketingComplete: false };
  const server = buildTools(job, outcome);

  const isExec = job.phase === 'execution';
  let prompt: string;
  let mcpTools: string[];

  if (isExec) {
    mcpTools = EXEC_TOOLS;
    const camp = getCampaignByProject(project.id);
    const budgetLine = camp
      ? `The hard budget cap is $${(camp.budget_cents / 100).toFixed(2)} ${camp.currency}, of which $${(camp.spent_cents / 100).toFixed(2)} is already committed.`
      : `The budget is $0.`;
    const cats = ROLE_CATEGORIES[job.kind] || ROLE_CATEGORIES.organic;
    const connected = autoChannels(); // only connected/auto-publishable channels
    const inScope = CHANNELS.filter((c) => cats.includes(c.category) && connected.includes(c.key) && c.key !== 'webhook' && c.key !== 'smtp');
    const labels = inScope.map((c) => `${c.label} (${c.key})`).join(', ');
    const existing = camp ? listActions(camp.id).filter((a) => inScope.some((c) => c.key === a.channel)).map((a) => a.title) : [];
    const findings = listFindings(project.id)
      .map((f) => `- [${f.category}] ${f.title}: ${f.summary ?? ''}`).join('\n') || '(see saved findings)';
    prompt = args.resumeSessionId
      ? `Continue your role from where you left off; propose only for connected channels (${labels || 'none — stop'}), then stop.`
      : executionPrompt(project, job.kind, budgetLine, labels, findings, existing);
  } else if (job.kind === 'research') {
    mcpTools = RESEARCH_TOOLS;
    prompt = args.resumeSessionId
      ? `Continue the research from where you left off. Review what you have already found and finish the remaining steps, then call mark_research_complete.`
      : researchPrompt(project, args.attachments ?? []);
  } else {
    mcpTools = MARKETING_TOOLS;
    prompt = args.resumeSessionId
      ? `Continue building the marketing plan from where you left off, then call mark_marketing_complete.`
      : marketingPrompt(project, args.findingsText ?? '(see saved findings)');
  }

  const options: any = {
    cwd: projectDir(project.id),
    allowedTools: ['WebSearch', 'WebFetch', 'Read', 'Glob', 'Grep', ...mcpTools],
    disallowedTools: ['Bash', 'Write', 'Edit'],
    permissionMode: 'bypassPermissions',
    mcpServers: { marketer: server },
    abortController: abort,
    maxTurns: 80,
    includePartialMessages: false,
  };
  if (process.env.AGENT_MODEL) options.model = process.env.AGENT_MODEL;
  if (args.resumeSessionId) options.resume = args.resumeSessionId;

  const startNote = isExec ? (ROLE_LABELS[job.kind] || 'Executing marketing actions')
    : job.kind === 'research' ? 'Scouring the web to understand the product and market'
    : 'Building the marketing strategy';
  log(job, 'status', args.resumeSessionId ? 'Resumed' : 'Started', startNote);
  touchJob(job.id);

  for await (const message of query({ prompt, options })) {
    touchJob(job.id); // heartbeat: proves this job is alive to reconcile()
    // Pause is signalled via the DB (the only state shared across route
    // bundles): if the user paused this job, stop the agent loop now.
    if (abort.signal.aborted || getJob(job.id)?.status === 'paused') {
      if (!abort.signal.aborted) abort.abort();
      break;
    }

    if (message.type === 'system') {
      // The init system message carries the session id well before the final
      // result — capture it so a pause/resume can continue this exact session.
      const sid = (message as any).session_id;
      if (sid && sid !== outcome.sessionId) {
        outcome.sessionId = sid;
        updateJob(job.id, { session_id: sid });
      }
      continue;
    }

    if (message.type === 'assistant') {
      for (const block of (message as any).message.content) {
        if (block.type === 'text' && block.text?.trim()) {
          log(job, 'text', undefined, block.text.trim());
        } else if (block.type === 'tool_use') {
          const builtin = !String(block.name).startsWith(TOOL_PREFIX);
          // Built-in tool calls (WebSearch/WebFetch/Read) are logged here;
          // our own MCP tools log richer lines from inside their handlers.
          if (builtin) {
            const q = block.input?.query || block.input?.url || block.input?.prompt || block.input?.file_path || '';
            log(job, 'tool_use', String(block.name), typeof q === 'string' ? q : JSON.stringify(block.input));
          }
        }
      }
    } else if (message.type === 'result') {
      outcome.sessionId = (message as any).session_id;
      if ((message as any).result) outcome.finalText = (message as any).result;
      if (outcome.sessionId) updateJob(job.id, { session_id: outcome.sessionId });
      if ((message as any).subtype && (message as any).subtype !== 'success') {
        log(job, 'error', 'Run ended', String((message as any).subtype));
      }
    }
  }

  return outcome;
}

// Revise a single proposed action from user feedback, then return it to the
// approval queue. Focused single-purpose agent — not part of the swarm.
export async function runRevision(opts: { action: ActionRow; feedback: string; abort: AbortController }): Promise<boolean> {
  const { action, feedback, abort } = opts;
  const project = getProject(action.project_id);
  if (!project) return false;
  const campaign = getCampaignByProject(action.project_id);
  let updated = false;

  const submit = tool(
    'submit_revision',
    'Save the revised action. Call exactly once with the full improved fields (write complete copy, not a diff).',
    {
      title: z.string(),
      summary: z.string(),
      content: z.string().describe('The full revised ready-to-publish copy'),
      cost_usd: z.number().optional().describe('Updated estimated cost in USD, only if it changed'),
      targeting: z.string().optional(),
      subject: z.string().optional().describe('Email subject, if applicable'),
      schedule: z.string().optional(),
      rationale: z.string().optional(),
    },
    async (a) => {
      const cur = getAction(action.id);
      if (!cur) return { content: [{ type: 'text', text: 'Action no longer exists.' }], isError: true };
      const meta = cur.meta ? JSON.parse(cur.meta) : {};
      for (const k of ['targeting', 'subject', 'schedule', 'rationale'] as const) {
        if ((a as any)[k] !== undefined) meta[k] = (a as any)[k];
      }
      const cost = a.cost_usd !== undefined ? Math.max(0, Math.round(a.cost_usd * 100)) : cur.cost_cents;
      updateAction(action.id, {
        title: a.title, summary: a.summary, content: a.content, cost_cents: cost,
        meta: JSON.stringify(meta), status: 'proposed', result: null,
      });
      updated = true;
      emitEvent({ type: 'finding', projectId: action.project_id });
      return { content: [{ type: 'text', text: 'Revision saved; the action is back in the approval queue.' }] };
    },
  );

  const server = createSdkMcpServer({ name: 'reviser', version: '1.0.0', tools: [submit] });
  const meta = action.meta ? JSON.parse(action.meta) : {};
  const budgetLine = campaign
    ? `Budget cap $${(campaign.budget_cents / 100).toFixed(2)}, $${(campaign.spent_cents / 100).toFixed(2)} committed, $${((campaign.budget_cents - campaign.spent_cents) / 100).toFixed(2)} remaining.`
    : 'Budget $0.';

  const prompt = [
    `You are refining ONE proposed marketing action based on the user's feedback. Keep it sharp, on-brand for this product, ETHICAL (no spam, fake engagement, deceptive or audience-annoying tactics), and within budget. ${budgetLine}`,
    directionBlock(project.id),
    ``,
    `PRODUCT: ${project.prompt}${project.url ? ` (${project.url})` : ''}`,
    `CHANNEL: ${channelDef(action.channel).label} · ${action.kind}`,
    `CURRENT TITLE: ${action.title}`,
    `CURRENT SUMMARY: ${action.summary || ''}`,
    meta.subject ? `CURRENT SUBJECT: ${meta.subject}` : '',
    meta.targeting ? `CURRENT TARGETING: ${meta.targeting}` : '',
    `CURRENT CONTENT:\n${action.content || '(none)'}`,
    ``,
    `USER FEEDBACK / ADJUSTMENT:\n${feedback}`,
    ``,
    `Keep it channel-native and ready-to-post (no stage directions). For X/Mastodon/Threads/Instagram/TikTok posts, ensure 2–4 relevant hashtags for reach (on the final tweet of a thread); no hashtags for Reddit/Hacker News.`,
    `If this is an email/outreach action, keep it templated with merge tokens — "Hi {{first_name}}," and {{company}} where natural — never hardcode a name; the app fills them per recipient.`,
    `Apply the feedback: preserve what works, change what they ask for. If the feedback needs fresh facts, you may use web search. Then call submit_revision exactly once with the complete revised action.`,
  ].filter(Boolean).join('\n');

  const options: any = {
    cwd: projectDir(project.id),
    allowedTools: ['WebSearch', 'WebFetch', 'Read', 'mcp__reviser__submit_revision'],
    disallowedTools: ['Bash', 'Write', 'Edit'],
    permissionMode: 'bypassPermissions',
    mcpServers: { reviser: server },
    abortController: abort,
    maxTurns: 14,
  };
  if (process.env.AGENT_MODEL) options.model = process.env.AGENT_MODEL;

  for await (const _m of query({ prompt, options })) {
    if (abort.signal.aborted) break;
  }
  return updated;
}

// Prepare a name-matched brand account for a channel: check handle availability,
// write the profile kit, and hand the human a one-click signup link + steps.
// We never auto-create accounts — platforms require human verification.
export async function runAccountKit(opts: { projectId: string; channel: string; abort: AbortController }): Promise<boolean> {
  const { projectId, channel, abort } = opts;
  const project = getProject(projectId);
  const campaign = getCampaignByProject(projectId);
  if (!project || !campaign) return false;
  const def = channelDef(channel);
  let created = false;

  const submit = tool(
    'submit_account_kit',
    'Save the prepared brand-account setup as an action for the user to finalize. Call exactly once.',
    {
      handle: z.string().describe('Best AVAILABLE name-matched @handle/username'),
      fallback_handles: z.array(z.string()).optional().describe('Alternatives if the first is taken'),
      availability_note: z.string().optional().describe('What you found about availability'),
      display_name: z.string(),
      bio: z.string().describe('Profile/bio/about text optimized for this platform'),
      link: z.string().optional(),
      profile_image_brief: z.string().optional(),
      banner_brief: z.string().optional(),
      signup_url: z.string().describe('Official signup URL for this platform'),
      steps: z.string().describe('Step-by-step instructions for the human to create AND verify the account'),
    },
    async (a) => {
      const content = [
        `BRAND ACCOUNT SETUP — ${def.label}`,
        ``,
        `Recommended handle: ${a.handle}`,
        a.fallback_handles?.length ? `Alternatives: ${a.fallback_handles.join(', ')}` : '',
        a.availability_note ? `Availability: ${a.availability_note}` : '',
        `Display name: ${a.display_name}`,
        ``,
        `Bio / About:\n${a.bio}`,
        a.link ? `\nLink: ${a.link}` : '',
        a.profile_image_brief ? `\nProfile image: ${a.profile_image_brief}` : '',
        a.banner_brief ? `Banner image: ${a.banner_brief}` : '',
        ``,
        `▶ Create the account here: ${a.signup_url}`,
        ``,
        `Steps:\n${a.steps}`,
      ].filter(Boolean).join('\n');
      createAction({
        project_id: projectId, campaign_id: campaign.id, channel, kind: 'account',
        title: `Set up ${def.label}: ${a.handle}`,
        summary: 'Name-matched brand account — ready for you to create & connect.',
        content, cost_cents: 0, meta: { handle: a.handle, signup_url: a.signup_url, account_setup: true },
      });
      created = true;
      emitEvent({ type: 'finding', projectId });
      return { content: [{ type: 'text', text: 'Account-setup kit queued for approval.' }] };
    },
  );

  const server = createSdkMcpServer({ name: 'accounts', version: '1.0.0', tools: [submit] });
  const prompt = [
    `You are preparing a brand account for this product on ${def.label}, matching the product/service name.`,
    `IMPORTANT: do NOT attempt to create the account yourself. Every major platform requires human verification (email/phone/CAPTCHA) and bans bot-created accounts. Your job is to make the human's signup one-click and on-brand, fully within platform ToS.`,
    ``,
    `PRODUCT: ${project.prompt}${project.url ? ` (${project.url})` : ''}`,
    `Brand name to match: ${project.title}`,
    ``,
    `1. Use web search to check whether the brand name is available as a handle on ${def.label}; suggest close fallbacks if it's taken.`,
    `2. Write a platform-appropriate display name, bio/about, a link, and short briefs for the profile + banner images.`,
    `3. Give the official signup URL and clear step-by-step instructions, including the verification the human must complete.`,
    `Then call submit_account_kit once.`,
  ].join('\n');

  const options: any = {
    cwd: projectDir(project.id),
    allowedTools: ['WebSearch', 'WebFetch', 'mcp__accounts__submit_account_kit'],
    disallowedTools: ['Bash', 'Write', 'Edit'],
    permissionMode: 'bypassPermissions',
    mcpServers: { accounts: server },
    abortController: abort,
    maxTurns: 14,
  };
  if (process.env.AGENT_MODEL) options.model = process.env.AGENT_MODEL;

  for await (const _m of query({ prompt, options })) {
    if (abort.signal.aborted) break;
  }
  return created;
}
