import { NextResponse } from 'next/server';
import { createAccountKit } from '@/lib/orchestrator';

export const runtime = 'nodejs';
export const maxDuration = 60;

// POST { channel } — agent prepares a name-matched brand account kit for that channel.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const channel = String(body.channel || '');
  if (!channel) return NextResponse.json({ error: 'channel required' }, { status: 400 });
  const res = createAccountKit(id, channel);
  return NextResponse.json(res, { status: res.ok ? 200 : 400 });
}
