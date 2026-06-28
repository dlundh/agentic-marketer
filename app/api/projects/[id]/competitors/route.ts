import { NextResponse } from 'next/server';
import { analyzeCompetitors } from '@/lib/orchestrator';

export const runtime = 'nodejs';
export const maxDuration = 30;

// Kick off (or re-run) the competitive-advantage analysis. `count` = how many
// NEW competitors to analyze (those already analyzed are excluded automatically).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const count = Math.max(1, Math.min(25, Math.round(Number(body.count) || 5)));
  const job = analyzeCompetitors(id, count);
  if (!job) return NextResponse.json({ error: 'A competitive analysis is already running, or the project was not found.' }, { status: 409 });
  return NextResponse.json({ ok: true, jobId: job.id });
}
