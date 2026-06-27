import { NextResponse } from 'next/server';
import { listConnectors, upsertConnector, disconnectConnector, setConnectorExcluded, updateConnectorSecrets, getConnector } from '@/lib/db';
import { CHANNELS, seedConnectors, channelDef, pingWebhook, verifySmtp } from '@/lib/connectors';
import { listAdAccounts, listPages } from '@/lib/meta';

export const runtime = 'nodejs';
export const maxDuration = 30;

// List the channel catalog with connection status (secrets never returned).
export async function GET() {
  seedConnectors();
  const rows = listConnectors();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const connectors = CHANNELS.map((ch) => {
    const row = byKey.get(ch.key);
    const base: any = {
      key: ch.key, label: ch.label, category: ch.category, executor: ch.executor,
      paid: !!ch.paid, note: ch.note, connected: !!row?.connected, excluded: !!row?.excluded,
    };
    // Expose the non-sensitive Meta selection (accounts/pages/choices) for the picker.
    if (ch.key === 'meta_ads' && row?.connected && row.secrets) {
      const s = JSON.parse(row.secrets);
      base.meta = { accounts: s.accounts || [], pages: s.pages || [], ad_account_id: s.ad_account_id || '', page_id: s.page_id || '', default_image_url: s.default_image_url || '', default_link: s.default_link || '', handle: s.handle || '' };
    }
    return base;
  });
  return NextResponse.json({ connectors });
}

// Connect / disconnect. We VERIFY before marking connected — a connector only
// counts as connected if it has something we can actually execute with
// (a working posting webhook, or authenticating SMTP). A bare handle/token is
// stored as a note but does NOT auto-execute.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const key = String(body.key || '');
  const def = channelDef(key);
  if (!def) return NextResponse.json({ error: 'unknown channel' }, { status: 400 });

  // Toggle whether the swarm generates actions for this channel (kept connected).
  if (typeof body.exclude === 'boolean') {
    setConnectorExcluded(key, body.exclude);
    return NextResponse.json({ ok: true, excluded: body.exclude });
  }

  // Re-fetch Meta ad accounts + Pages (e.g. after creating a new Page) — no re-auth.
  if (body.refresh && key === 'meta_ads') {
    const conn = getConnector('meta_ads');
    const s = conn?.secrets ? JSON.parse(conn.secrets) : null;
    if (!s?.access_token) return NextResponse.json({ error: 'Meta isn’t connected.' }, { status: 400 });
    try {
      const accounts = await listAdAccounts(s.access_token);
      const pages = await listPages(s.access_token);
      updateConnectorSecrets('meta_ads', { accounts, pages });
      return NextResponse.json({ ok: true, accounts: accounts.length, pages: pages.length });
    } catch (e: any) {
      return NextResponse.json({ error: String(e?.message || e) }, { status: 400 });
    }
  }

  // Update Meta selection (ad account / page / default ad image) without re-auth.
  if (body.select && key === 'meta_ads') {
    const patch: any = {};
    for (const f of ['ad_account_id', 'page_id', 'default_image_url', 'default_link'] as const) {
      if (body.select[f] !== undefined) patch[f] = String(body.select[f]);
    }
    updateConnectorSecrets('meta_ads', patch);
    return NextResponse.json({ ok: true });
  }

  if (body.connect === false) {
    disconnectConnector(key);
    return NextResponse.json({ ok: true, connected: false, message: 'Disconnected.' });
  }

  const secrets = body.secrets || {};
  let connected = false;
  let message = '';

  if (key === 'smtp') {
    const v = await verifySmtp(secrets);
    connected = v.ok; message = v.message;
  } else if (secrets.url) {
    const v = await pingWebhook(secrets.url);
    connected = v.ok; message = v.message;
  } else {
    // Only a handle/token was given — nothing we can post with.
    message = 'Saved. This channel stays publish-ready (copy/paste) until you add a posting webhook URL (Zapier / Make / Buffer / n8n) or connect SMTP for email.';
  }

  const executor = connected ? (key === 'smtp' ? 'smtp' : 'webhook') : def.executor;
  upsertConnector({ key, label: def.label, executor, secrets, connected });
  return NextResponse.json({ ok: connected || !secrets.url, connected, message });
}
