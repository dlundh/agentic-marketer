import { NextResponse } from 'next/server';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { listProjects, listJobs, addFile } from '@/lib/db';
import { createNewProject, launchJob, reconcile } from '@/lib/orchestrator';
import { projectDir } from '@/lib/agent';

export const runtime = 'nodejs';
export const maxDuration = 60;

// List all projects (history) with their jobs.
export async function GET() {
  reconcile(); // once: flip interrupted jobs (not in the live registry) to paused
  const projects = listProjects().map((p) => ({ ...p, jobs: listJobs(p.id) }));
  return NextResponse.json({ projects });
}

// Create a new marketing project from prompt + optional URL + attachments.
export async function POST(req: Request) {
  const form = await req.formData();
  const prompt = String(form.get('prompt') ?? '').trim();
  const url = String(form.get('url') ?? '').trim() || undefined;
  if (!prompt && !url) {
    return NextResponse.json({ error: 'Describe what you want to market, or provide a URL.' }, { status: 400 });
  }

  const { project, job } = createNewProject({ prompt: prompt || `Market the product at ${url}`, url });

  // Persist attachments into the project working dir so the agent can Read them.
  const attachments: string[] = [];
  const dir = projectDir(project.id);
  for (const entry of form.getAll('files')) {
    if (typeof entry === 'string') continue;
    const file = entry as File;
    const buf = Buffer.from(await file.arrayBuffer());
    const safeName = file.name.replace(/[^a-z0-9._-]+/gi, '_');
    const dest = path.join(dir, safeName);
    await writeFile(dest, buf);
    attachments.push(safeName);
    addFile({
      project_id: project.id, job_id: job.id, name: file.name, path: dest,
      mime: file.type || 'application/octet-stream', size: buf.length, kind: 'attachment',
    });
  }

  launchJob(job.id, { attachments });
  return NextResponse.json({ project });
}
