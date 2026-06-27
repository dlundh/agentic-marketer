import { NextResponse } from 'next/server';
import { listConnectors, upsertConnector, disconnectConnector, setConnectorExcluded, updateConnectorSecrets, getConnector } from '@/lib/db';
import { CHANNELS, seedConnectors, channelDef, pingWebhook, verifySmtp } from '@/lib/connectors';
import { listAdAccounts, listPages } from '@/lib/meta';

export const runtime = 'nodejs';
export const maxDuration = 30;

// Connectors are per-project — every call must name the project.
export async function GET(req: Request) {
  const projectId = new URL(req.url).searchParams.get('project') || '';
  if (!projectId) return NextResponse.json({ connectors: [] });
  seedConnectors(projectId);
  const byKey = new Map(listConnectors(projectId).map((r) => [r.key, r]));
  const connectors = CHANNELS.map((ch) => {
    const row = byKey.get(ch.key);
    const base: any = {
      key: ch.key, label: ch.label, category: ch.category, executor: ch.executor,
      paid: !!ch.paid, note: ch.note, connected: !!row?.connected, excluded: !!row?.excluded,
    };
    if (ch.key === 'meta_ads' && row?.connected && row.secrets) {
      const s = JSON.parse(row.secrets);
      base.meta = { accounts: s.accounts || [], pages: s.pages || [], ad_account_id: s.ad_account_id || '', page_id: s.page_id || '', default_image_url: s.default_image_url || '', default_link: s.default_link || '', handle: s.handle || '' };
    }
    return base;
  });
  return NextResponse.json({ connectors });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const projectId = String(body.project_id || '');
  const key = String(body.key || '');
  const def = channelDef(key);
  if (!projectId) return NextResponse.json({ error: 'project required' }, { status: 400 });
  if (!def) return NextResponse.json({ error: 'unknown channel' }, { status: 400 });

  if (typeof body.exclude === 'boolean') {
    setConnectorExcluded(projectId, key, body.exclude);
    return NextResponse.json({ ok: true, excluded: body.exclude });
  }

  if (body.refresh && key === 'meta_ads') {
    const conn = getConnector(projectId, 'meta_ads');
    const s = conn?.secrets ? JSON.parse(conn.secrets) : null;
    if (!s?.access_token) return NextResponse.json({ error: 'Meta isn’t connected.' }, { status: 400 });
    try {
      const accounts = await listAdAccounts(s.access_token);
      const pages = await listPages(s.access_token);
      updateConnectorSecrets(projectId, 'meta_ads', { accounts, pages });
      return NextResponse.json({ ok: true, accounts: accounts.length, pages: pages.length });
    } catch (e: any) {
      return NextResponse.json({ error: String(e?.message || e) }, { status: 400 });
    }
  }

  if (body.select && key === 'meta_ads') {
    const patch: any = {};
    for (const f of ['ad_account_id', 'page_id', 'default_image_url', 'default_link'] as const) {
      if (body.select[f] !== undefined) patch[f] = String(body.select[f]);
    }
    updateConnectorSecrets(projectId, 'meta_ads', patch);
    return NextResponse.json({ ok: true });
  }

  if (body.connect === false) {
    disconnectConnector(projectId, key);
    return NextResponse.json({ ok: true, connected: false, message: 'Disconnected.' });
  }

  const secrets = body.secrets || {};
  let connected = false;
  let message = '';
  if (key === 'smtp') {
    const v = await verifySmtp(secrets); connected = v.ok; message = v.message;
  } else if (secrets.url) {
    const v = await pingWebhook(secrets.url); connected = v.ok; message = v.message;
  } else {
    message = 'Saved. This channel stays publish-ready (copy/paste) until you add a posting webhook URL (Zapier / Make / Buffer / n8n) or connect SMTP for email.';
  }
  const executor = connected ? (key === 'smtp' ? 'smtp' : 'webhook') : def.executor;
  upsertConnector(projectId, { key, label: def.label, executor, secrets, connected });
  return NextResponse.json({ ok: connected || !secrets.url, connected, message });
}
