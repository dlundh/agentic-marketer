import { NextResponse } from 'next/server';
import { upsertConnector } from '@/lib/db';
import { channelDef } from '@/lib/connectors';
import {
  normalizeInstance, registerMastodonApp, authorizeUrl,
  pkce, xAuthorizeUrl, redditAuthorizeUrl, linkedinAuthorizeUrl,
} from '@/lib/oauth';
import { metaAuthorizeUrl } from '@/lib/meta';

export const runtime = 'nodejs';
export const maxDuration = 30;

// Begin OAuth for mastodon | x | reddit. Mastodon self-registers; X/Reddit need
// the user-supplied client id/secret. We stash pending creds + a CSRF state
// (+ PKCE verifier for X) on the connector, and return the authorize URL.
export async function POST(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const body = await req.json().catch(() => ({}));
  const origin = new URL(req.url).origin;
  const redirectUri = `${origin}/api/oauth/${provider}/callback`;
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const label = channelDef(provider).label;

  try {
    if (provider === 'mastodon') {
      const instance = normalizeInstance(body.instance || '');
      if (!instance || !instance.includes('.')) return NextResponse.json({ error: 'Enter your instance, e.g. mastodon.social' }, { status: 400 });
      const { client_id, client_secret } = await registerMastodonApp(instance, redirectUri);
      upsertConnector({ key: 'mastodon', label, executor: 'mastodon', connected: false, secrets: { instance, client_id, client_secret, redirect_uri: redirectUri, pending_state: state } });
      return NextResponse.json({ url: authorizeUrl(instance, client_id, redirectUri, state) });
    }

    const client_id = String(body.client_id || '').trim();
    const client_secret = String(body.client_secret || '').trim();
    if (!client_id || !client_secret) return NextResponse.json({ error: 'Paste the Client ID and Client Secret from your developer app.' }, { status: 400 });

    if (provider === 'x') {
      const { verifier, challenge } = pkce();
      upsertConnector({ key: 'x', label, executor: 'x', connected: false, secrets: { client_id, client_secret, redirect_uri: redirectUri, pending_state: state, code_verifier: verifier } });
      return NextResponse.json({ url: xAuthorizeUrl(client_id, redirectUri, state, challenge) });
    }
    if (provider === 'reddit') {
      upsertConnector({ key: 'reddit', label, executor: 'reddit', connected: false, secrets: { client_id, client_secret, redirect_uri: redirectUri, pending_state: state } });
      return NextResponse.json({ url: redditAuthorizeUrl(client_id, redirectUri, state) });
    }
    if (provider === 'linkedin') {
      upsertConnector({ key: 'linkedin', label, executor: 'linkedin', connected: false, secrets: { client_id, client_secret, redirect_uri: redirectUri, pending_state: state } });
      return NextResponse.json({ url: linkedinAuthorizeUrl(client_id, redirectUri, state) });
    }
    if (provider === 'meta_ads') {
      upsertConnector({ key: 'meta_ads', label, executor: 'meta_ads', connected: false, secrets: { client_id, client_secret, redirect_uri: redirectUri, pending_state: state } });
      return NextResponse.json({ url: metaAuthorizeUrl(client_id, redirectUri, state) });
    }
    return NextResponse.json({ error: 'Unsupported provider.' }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 400 });
  }
}
