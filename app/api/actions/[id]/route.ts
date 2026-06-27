import { NextResponse } from 'next/server';
import { approveAction, rejectAction, reviseAction, pauseAd, resumeAd, removeAd } from '@/lib/orchestrator';

export const runtime = 'nodejs';
export const maxDuration = 60;

// POST { action: 'approve' | 'reject' | 'revise', feedback? }
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  if (body.action === 'reject') {
    return NextResponse.json({ ok: rejectAction(id) });
  }
  if (body.action === 'pause_ad') return NextResponse.json(await pauseAd(id));
  if (body.action === 'resume_ad') { const r = await resumeAd(id); return NextResponse.json(r, { status: r.ok ? 200 : 400 }); }
  if (body.action === 'remove_ad') return NextResponse.json(await removeAd(id));
  if (body.action === 'revise') {
    const ok = reviseAction(id, String(body.feedback || ''));
    return NextResponse.json(ok ? { ok } : { ok, error: 'Could not revise this action.' }, { status: ok ? 200 : 400 });
  }
  if (body.action === 'approve') {
    const res = await approveAction(id, { list_id: body.list_id });
    return NextResponse.json(res, { status: res.ok ? 200 : 400 });
  }
  return NextResponse.json({ error: 'unknown action' }, { status: 400 });
}
