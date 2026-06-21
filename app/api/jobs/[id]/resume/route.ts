import { NextResponse } from 'next/server';
import { resumeJob } from '@/lib/orchestrator';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return NextResponse.json({ ok: resumeJob(id) });
}
