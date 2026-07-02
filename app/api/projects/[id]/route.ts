import { NextResponse } from 'next/server';
import {
  getProject, listJobs, listFindings, listFiles, listActivity,
  getCampaignByProject, listActions, listEmailLists, listDirectives, listDailyMetrics,
} from '@/lib/db';
import { isRunning, autonomousTick, setProjectPaused, removeProject } from '@/lib/orchestrator';
import { isAutoExecutable } from '@/lib/connectors';

export const runtime = 'nodejs';

// Pause / resume all autonomous activity for this app.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  if (body.action === 'pause' || body.action === 'resume') {
    const ok = await setProjectPaused(id, body.action === 'pause');
    return NextResponse.json({ ok }, { status: ok ? 200 : 404 });
  }
  return NextResponse.json({ error: 'unknown action' }, { status: 400 });
}

// Permanently delete this app and all its data.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ok = removeProject(id);
  return NextResponse.json({ ok }, { status: ok ? 200 : 404 });
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: 'not found' }, { status: 404 });

  // Advance the autonomous loop (schedule/refill/publish) whenever the project is
  // viewed — throttled internally. Keeps full-auto progressing without relying on
  // a background timer surviving dev hot-reloads.
  autonomousTick(id);

  const jobs = listJobs(id).map((j) => ({
    ...j,
    live: isRunning(j.id),
    activity: listActivity(j.id),
  }));

  const campaign = getCampaignByProject(id);
  const actions = (campaign ? listActions(campaign.id) : []).map((a) => ({ ...a, auto: isAutoExecutable(a) }));

  return NextResponse.json({
    project,
    jobs,
    findings: listFindings(id),
    files: listFiles(id),
    campaign: campaign ?? null,
    actions,
    lists: listEmailLists(id),
    directives: listDirectives(id),
    metrics: campaign ? listDailyMetrics(campaign.id, 60) : [],
  });
}
