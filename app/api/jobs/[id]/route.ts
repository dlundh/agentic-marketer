import { NextResponse } from 'next/server';
import { getJob, listActivity, listJobFiles, listFindings } from '@/lib/db';
import { isRunning } from '@/lib/orchestrator';

export const runtime = 'nodejs';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = getJob(id);
  if (!job) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const findings = listFindings(job.project_id).filter((f) => f.job_id === id);
  return NextResponse.json({
    job: { ...job, live: isRunning(job.id) },
    activity: listActivity(id),
    files: listJobFiles(id),
    findings,
  });
}
