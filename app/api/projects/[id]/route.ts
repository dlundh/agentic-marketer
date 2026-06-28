import { NextResponse } from 'next/server';
import {
  getProject, listJobs, listFindings, listFiles, listActivity,
  getCampaignByProject, listActions, listEmailLists, listDirectives,
} from '@/lib/db';
import { isRunning, autonomousTick } from '@/lib/orchestrator';
import { isAutoExecutable } from '@/lib/connectors';

export const runtime = 'nodejs';

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
  });
}
