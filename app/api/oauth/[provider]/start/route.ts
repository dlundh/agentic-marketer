import { NextResponse } from 'next/server';
import { upsertConnector } from '@/lib/db';
import { channelDef } from '@/lib/connectors';
import {
  normalizeInstance, registerMastodonApp, authorizeUrl,
  pkce, xAuthorizeUrl, redditAuthorizeUrl, linkedinAuthorizeUrl,
} from '@/lib/oauth';
import { metaAuthorizeUrl } from '@/lib/meta';
import { googleAuthorizeUrl } from '@/lib/google';
import { redditAdsAuthorizeUrl } from '@/lib/redditads';

export const runtime = 'nodejs';
export const maxDuration = 30;

// Begin OAuth for mastodon | x | reddit. Mastodon self-registers; X/Reddit need
// the user-supplied client id/secret. We stash pending creds + a CSRF state
// (+ PKCE verifier for X) on the connector, and return the authorize URL.
export async function POST(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const body = await req.json().catch(() => ({}));
  const projectId = String(body.project_id || '');
  if (!projectId) return NextResponse.json({ error: 'No project selected.' }, { status: 400 });
  const origin = new URL(req.url).origin;
  const redirectUri = `${origin}/api/oauth/${provider}/callback`;
  // Carry the project through the round-trip (the callback parses it back).
  const state = `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}__${projectId}`;
  const label = channelDef(provider).label;

  try {
    if (provider === 'mastodon') {
      const instance = normalizeInstance(body.instance || '');
      if (!instance || !instance.includes('.')) return NextResponse.json({ error: 'Enter your instance, e.g. mastodon.social' }, { status: 400 });
      const { client_id, client_secret } = await registerMastodonApp(instance, redirectUri);
      upsertConnector(projectId, { key: 'mastodon', label, executor: 'mastodon', connected: false, secrets: { instance, client_id, client_secret, redirect_uri: redirectUri, pending_state: state } });
      return NextResponse.json({ url: authorizeUrl(instance, client_id, redirectUri, state) });
    }

    const client_id = String(body.client_id || '').trim();
    const client_secret = String(body.client_secret || '').trim();
    if (!client_id || !client_secret) return NextResponse.json({ error: 'Paste the Client ID and Client Secret from your developer app.' }, { status: 400 });

    if (provider === 'x') {
      const { verifier, challenge } = pkce();
      upsertConnector(projectId, { key: 'x', label, executor: 'x', connected: false, secrets: { client_id, client_secret, redirect_uri: redirectUri, pending_state: state, code_verifier: verifier } });
      return NextResponse.json({ url: xAuthorizeUrl(client_id, redirectUri, state, challenge) });
    }
    if (provider === 'reddit') {
      upsertConnector(projectId, { key: 'reddit', label, executor: 'reddit', connected: false, secrets: { client_id, client_secret, redirect_uri: redirectUri, pending_state: state } });
      return NextResponse.json({ url: redditAuthorizeUrl(client_id, redirectUri, state) });
    }
    if (provider === 'linkedin') {
      upsertConnector(projectId, { key: 'linkedin', label, executor: 'linkedin', connected: false, secrets: { client_id, client_secret, redirect_uri: redirectUri, pending_state: state } });
      return NextResponse.json({ url: linkedinAuthorizeUrl(client_id, redirectUri, state) });
    }
    if (provider === 'meta_ads') {
      upsertConnector(projectId, { key: 'meta_ads', label, executor: 'meta_ads', connected: false, secrets: { client_id, client_secret, redirect_uri: redirectUri, pending_state: state } });
      return NextResponse.json({ url: metaAuthorizeUrl(client_id, redirectUri, state) });
    }
    if (provider === 'google_ads') {
      // Google Ads also needs a developer token + target customer id (entered in the dialog).
      const developer_token = String(body.developer_token || '').trim();
      const customer_id = String(body.customer_id || '').trim();
      const login_customer_id = String(body.login_customer_id || '').trim();
      if (!developer_token || !customer_id) return NextResponse.json({ error: 'Google Ads also needs your Developer token and Customer ID.' }, { status: 400 });
      upsertConnector(projectId, { key: 'google_ads', label, executor: 'google_ads', connected: false, secrets: { client_id, client_secret, developer_token, customer_id, login_customer_id, redirect_uri: redirectUri, pending_state: state } });
      return NextResponse.json({ url: googleAuthorizeUrl(client_id, redirectUri, state) });
    }
    if (provider === 'reddit_ads') {
      upsertConnector(projectId, { key: 'reddit_ads', label, executor: 'reddit_ads', connected: false, secrets: { client_id, client_secret, redirect_uri: redirectUri, pending_state: state } });
      return NextResponse.json({ url: redditAdsAuthorizeUrl(client_id, redirectUri, state) });
    }
    return NextResponse.json({ error: 'Unsupported provider.' }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 400 });
  }
}
