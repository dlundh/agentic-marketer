import { NextResponse } from 'next/server';
import {
  launchCampaign, launchOptimizer, generateActions,
  addCampaignFunds, removeCampaignFunds, setDailyCap, setAutonomy, setKillSwitch, runAdOptimizer, setAutoPosts,
} from '@/lib/orchestrator';

export const runtime = 'nodejs';
export const maxDuration = 60;

const usdToCents = (v: any) => Math.max(0, Math.round(Number(v || 0) * 100));

// Launch the swarm, or operate on an existing campaign via {action}.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  switch (body.action) {
    case 'optimize': return NextResponse.json({ ok: launchOptimizer(id) });
    case 'generate': { const r = generateActions(id); return NextResponse.json(r, { status: r.ok ? 200 : 400 }); }
    case 'add_funds': return NextResponse.json({ ok: addCampaignFunds(id, usdToCents(body.amount_usd)) });
    case 'remove_funds': return NextResponse.json({ ok: removeCampaignFunds(id, usdToCents(body.amount_usd)) });
    case 'daily_cap': return NextResponse.json({ ok: setDailyCap(id, usdToCents(body.amount_usd)) });
    case 'autonomy': return NextResponse.json({ ok: setAutonomy(id, String(body.mode || '')) });
    case 'auto_posts': return NextResponse.json({ ok: setAutoPosts(id, !!body.on) });
    case 'full_auto': {
      // Master "fully automated marketing" switch: posts + ads, both auto.
      const on = !!body.on;
      setAutonomy(id, on ? 'autonomous' : 'approval');
      setAutoPosts(id, on);
      return NextResponse.json({ ok: true });
    }
    case 'kill': return NextResponse.json({ ok: await setKillSwitch(id, !!body.paused) });
    case 'optimize_ads': await runAdOptimizer(id); return NextResponse.json({ ok: true });
  }

  // Launch a new campaign.
  const budgetCents = usdToCents(body.budget_usd);
  const channels: string[] = Array.isArray(body.channels) ? body.channels : [];
  if (channels.length === 0) return NextResponse.json({ error: 'Select at least one channel.' }, { status: 400 });
  const campaign = launchCampaign(id, {
    budget_cents: budgetCents, channels, autonomy: body.autonomy, daily_cap_cents: usdToCents(body.daily_cap_usd),
  });
  if (!campaign) return NextResponse.json({ error: 'Project not found.' }, { status: 404 });
  return NextResponse.json({ campaign });
}
