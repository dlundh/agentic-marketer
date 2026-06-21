import { NextResponse } from 'next/server';
import { getProject, listJobs, listFindings, listFiles, listActivity } from '@/lib/db';
import { isRunning } from '@/lib/orchestrator';

export const runtime = 'nodejs';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const jobs = listJobs(id).map((j) => ({
    ...j,
    live: isRunning(j.id),
    activity: listActivity(j.id),
  }));
  return NextResponse.json({
    project,
    jobs,
    findings: listFindings(id),
    files: listFiles(id),
  });
}
