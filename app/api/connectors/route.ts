import { NextResponse } from 'next/server';
import { listConnectors, upsertConnector, disconnectConnector, getConnector } from '@/lib/db';
import { CHANNELS, seedConnectors, channelDef } from '@/lib/connectors';

export const runtime = 'nodejs';

// List the channel catalog with connection status (secrets never returned).
export async function GET() {
  seedConnectors();
  const rows = listConnectors();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const connectors = CHANNELS.map((ch) => {
    const row = byKey.get(ch.key);
    return {
      key: ch.key, label: ch.label, category: ch.category, executor: ch.executor,
      paid: !!ch.paid, note: ch.note, connected: !!row?.connected,
    };
  });
  return NextResponse.json({ connectors });
}

// Connect or disconnect a channel. Body: { key, connect: bool, secrets?: {...} }
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const key = String(body.key || '');
  const def = channelDef(key);
  if (!def) return NextResponse.json({ error: 'unknown channel' }, { status: 400 });

  if (body.connect === false) {
    disconnectConnector(key);
    return NextResponse.json({ ok: true });
  }
  upsertConnector({ key, label: def.label, executor: def.executor, secrets: body.secrets || {}, connected: true });
  return NextResponse.json({ ok: true });
}
