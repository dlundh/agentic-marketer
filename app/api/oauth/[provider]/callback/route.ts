import { getConnector, upsertConnector } from '@/lib/db';
import { channelDef } from '@/lib/connectors';
import {
  exchangeCode, verifyAccount,
  exchangeXCode, verifyXAccount,
  exchangeRedditCode, verifyRedditAccount,
} from '@/lib/oauth';

export const runtime = 'nodejs';
export const maxDuration = 30;

// OAuth redirect target for mastodon | x | reddit: exchange the code for a token,
// verify the account, store it, then bounce back to the app.
export async function GET(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const u = new URL(req.url);
  const origin = u.origin;
  const code = u.searchParams.get('code');
  const state = u.searchParams.get('state');
  const back = (status: string) => Response.redirect(`${origin}/?oauth=${provider}&status=${status}`, 302);

  const conn = getConnector(provider);
  const s = conn?.secrets ? JSON.parse(conn.secrets) : null;
  if (!code || !s || !state || state !== s.pending_state) return back('error');
  const label = channelDef(provider).label;

  try {
    if (provider === 'mastodon') {
      const token = await exchangeCode(s.instance, s.client_id, s.client_secret, code, s.redirect_uri);
      const acct = await verifyAccount(s.instance, token);
      upsertConnector({ key: 'mastodon', label, executor: 'mastodon', connected: true, secrets: { instance: s.instance, client_id: s.client_id, client_secret: s.client_secret, access_token: token, handle: acct.handle, profile: acct.url } });
      return back('connected');
    }
    if (provider === 'x') {
      const { access_token, refresh_token } = await exchangeXCode(s.client_id, s.client_secret, code, s.redirect_uri, s.code_verifier);
      const acct = await verifyXAccount(access_token);
      upsertConnector({ key: 'x', label, executor: 'x', connected: true, secrets: { client_id: s.client_id, client_secret: s.client_secret, access_token, refresh_token, handle: acct.handle, profile: acct.url } });
      return back('connected');
    }
    if (provider === 'reddit') {
      const { access_token, refresh_token } = await exchangeRedditCode(s.client_id, s.client_secret, code, s.redirect_uri);
      const acct = await verifyRedditAccount(access_token);
      upsertConnector({ key: 'reddit', label, executor: 'reddit', connected: true, secrets: { client_id: s.client_id, client_secret: s.client_secret, access_token, refresh_token, handle: acct.handle, profile: acct.url } });
      return back('connected');
    }
    return back('error');
  } catch {
    return back('error');
  }
}
