import { NextResponse } from 'next/server';
import { upsertConnector } from '@/lib/db';
import { channelDef } from '@/lib/connectors';
import { normalizeInstance, registerMastodonApp, authorizeUrl } from '@/lib/oauth';

export const runtime = 'nodejs';
export const maxDuration = 30;

// Begin the Mastodon OAuth flow: self-register the app on the user's instance,
// stash the client creds + a CSRF state, and return the authorize URL.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const instance = normalizeInstance(body.instance || '');
  if (!instance || !instance.includes('.')) {
    return NextResponse.json({ error: 'Enter your Mastodon instance, e.g. mastodon.social' }, { status: 400 });
  }
  const origin = new URL(req.url).origin;
  const redirectUri = `${origin}/api/oauth/mastodon/callback`;
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);

  try {
    const { client_id, client_secret } = await registerMastodonApp(instance, redirectUri);
    // Persist pending creds on the connector (connected stays false until callback).
    upsertConnector({
      key: 'mastodon', label: channelDef('mastodon').label, executor: 'mastodon', connected: false,
      secrets: { instance, client_id, client_secret, redirect_uri: redirectUri, pending_state: state },
    });
    return NextResponse.json({ url: authorizeUrl(instance, client_id, redirectUri, state) });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 400 });
  }
}
