import { NextResponse } from 'next/server';
import { pauseJob } from '@/lib/orchestrator';

export const runtime = 'nodejs';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return NextResponse.json({ ok: pauseJob(id) });
}
