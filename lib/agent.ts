import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import {
  DATA_DIR, uid, addActivity, addFinding, addFile, updateJob, updateProject,
  getProject, getJob, touchJob, type Job, type Project,
} from './db';
import { emitEvent } from './events';
import { renderPdf, type PdfSection } from './pdf';

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

  return createSdkMcpServer({
    name: 'marketer',
    version: '1.0.0',
    tools: [saveFinding, createPdf, markResearchComplete, markMarketingComplete],
  });
}

const TOOL_PREFIX = 'mcp__marketer__';
const MCP_TOOLS = [
  `${TOOL_PREFIX}save_finding`,
  `${TOOL_PREFIX}create_pdf_report`,
  `${TOOL_PREFIX}mark_research_complete`,
  `${TOOL_PREFIX}mark_marketing_complete`,
];

function researchPrompt(p: Project, attachments: string[]): string {
  return [
    `You are an autonomous market-research agent for a product/service marketing platform.`,
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

  let prompt: string;
  if (args.resumeSessionId) {
    prompt = job.kind === 'research'
      ? `Continue the research from where you left off. Review what you have already found and finish the remaining steps, then call mark_research_complete.`
      : `Continue building the marketing plan from where you left off, then call mark_marketing_complete.`;
  } else if (job.kind === 'research') {
    prompt = researchPrompt(project, args.attachments ?? []);
  } else {
    prompt = marketingPrompt(project, args.findingsText ?? '(see saved findings)');
  }

  const options: any = {
    cwd: projectDir(project.id),
    allowedTools: ['WebSearch', 'WebFetch', 'Read', 'Glob', 'Grep', ...MCP_TOOLS],
    disallowedTools: ['Bash', 'Write', 'Edit'],
    permissionMode: 'bypassPermissions',
    mcpServers: { marketer: server },
    abortController: abort,
    maxTurns: 80,
    includePartialMessages: false,
  };
  if (process.env.AGENT_MODEL) options.model = process.env.AGENT_MODEL;
  if (args.resumeSessionId) options.resume = args.resumeSessionId;

  log(job, 'status', args.resumeSessionId ? 'Resumed' : 'Started',
    job.kind === 'research' ? 'Scouring the web to understand the product and market' : 'Building the marketing strategy');
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
