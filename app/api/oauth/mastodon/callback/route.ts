import { getConnector, upsertConnector } from '@/lib/db';
import { channelDef } from '@/lib/connectors';
import { exchangeCode, verifyAccount } from '@/lib/oauth';

export const runtime = 'nodejs';
export const maxDuration = 30;

// OAuth redirect target: exchange the code for a token, verify the account, and
// store it. Then bounce back to the app.
export async function GET(req: Request) {
  const u = new URL(req.url);
  const origin = u.origin;
  const code = u.searchParams.get('code');
  const state = u.searchParams.get('state');
  const back = (status: string) => Response.redirect(`${origin}/?mastodon=${status}`, 302);

  const conn = getConnector('mastodon');
  const s = conn?.secrets ? JSON.parse(conn.secrets) : null;
  if (!code || !s || !state || state !== s.pending_state) return back('error');

  try {
    const token = await exchangeCode(s.instance, s.client_id, s.client_secret, code, s.redirect_uri);
    const acct = await verifyAccount(s.instance, token);
    upsertConnector({
      key: 'mastodon', label: channelDef('mastodon').label, executor: 'mastodon', connected: true,
      secrets: { instance: s.instance, client_id: s.client_id, client_secret: s.client_secret, access_token: token, handle: acct.handle, profile: acct.url },
    });
    return back('connected');
  } catch {
    return back('error');
  }
}
