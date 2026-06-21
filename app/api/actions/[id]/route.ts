import { NextResponse } from 'next/server';
import { approveAction, rejectAction } from '@/lib/orchestrator';

export const runtime = 'nodejs';
export const maxDuration = 60;

// POST { action: 'approve' | 'reject' }
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  if (body.action === 'reject') {
    return NextResponse.json({ ok: rejectAction(id) });
  }
  if (body.action === 'approve') {
    const res = await approveAction(id);
    return NextResponse.json(res, { status: res.ok ? 200 : 400 });
  }
  return NextResponse.json({ error: 'unknown action' }, { status: 400 });
}
