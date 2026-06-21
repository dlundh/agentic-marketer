import { NextResponse } from 'next/server';
import { launchCampaign, launchOptimizer } from '@/lib/orchestrator';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Launch the execution swarm for a project (or, with {action:'optimize'}, add an optimizer pass).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  if (body.action === 'optimize') {
    return NextResponse.json({ ok: launchOptimizer(id) });
  }

  const budgetCents = Math.max(0, Math.round(Number(body.budget_usd || 0) * 100));
  const channels: string[] = Array.isArray(body.channels) ? body.channels : [];
  if (channels.length === 0) {
    return NextResponse.json({ error: 'Select at least one channel.' }, { status: 400 });
  }
  const campaign = launchCampaign(id, { budget_cents: budgetCents, channels, autonomy: body.autonomy });
  if (!campaign) return NextResponse.json({ error: 'Project not found.' }, { status: 404 });
  return NextResponse.json({ campaign });
}
