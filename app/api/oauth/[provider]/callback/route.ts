import { getConnector, upsertConnector } from '@/lib/db';
import { channelDef } from '@/lib/connectors';
import {
  exchangeCode, verifyAccount,
  exchangeXCode, verifyXAccount,
  exchangeRedditCode, verifyRedditAccount,
  exchangeLinkedinCode, verifyLinkedinAccount,
} from '@/lib/oauth';
import { exchangeMetaCode, listAdAccounts, listPages } from '@/lib/meta';
import { exchangeGoogleCode } from '@/lib/google';
import { exchangeRedditAdsCode, listRedditAdAccounts } from '@/lib/redditads';

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
  const projectId = (state || '').split('__')[1] || '';
  const back = (status: string) => Response.redirect(`${origin}/?oauth=${provider}&status=${status}`, 302);

  const conn = projectId ? getConnector(projectId, provider) : undefined;
  const s = conn?.secrets ? JSON.parse(conn.secrets) : null;
  if (!code || !s || !state || state !== s.pending_state) return back('error');
  const label = channelDef(provider).label;
  const save = (secrets: any) => upsertConnector(projectId, { key: provider, label, executor: provider, connected: true, secrets });

  try {
    if (provider === 'mastodon') {
      const token = await exchangeCode(s.instance, s.client_id, s.client_secret, code, s.redirect_uri);
      const acct = await verifyAccount(s.instance, token);
      save({ instance: s.instance, client_id: s.client_id, client_secret: s.client_secret, access_token: token, handle: acct.handle, profile: acct.url });
      return back('connected');
    }
    if (provider === 'x') {
      const { access_token, refresh_token } = await exchangeXCode(s.client_id, s.client_secret, code, s.redirect_uri, s.code_verifier);
      const acct = await verifyXAccount(access_token);
      save({ client_id: s.client_id, client_secret: s.client_secret, access_token, refresh_token, handle: acct.handle, profile: acct.url });
      return back('connected');
    }
    if (provider === 'reddit') {
      const { access_token, refresh_token } = await exchangeRedditCode(s.client_id, s.client_secret, code, s.redirect_uri);
      const acct = await verifyRedditAccount(access_token);
      save({ client_id: s.client_id, client_secret: s.client_secret, access_token, refresh_token, handle: acct.handle, profile: acct.url });
      return back('connected');
    }
    if (provider === 'linkedin') {
      const token = await exchangeLinkedinCode(s.client_id, s.client_secret, code, s.redirect_uri);
      const acct = await verifyLinkedinAccount(token);
      save({ client_id: s.client_id, client_secret: s.client_secret, access_token: token, author: `urn:li:person:${acct.sub}`, handle: acct.name });
      return back('connected');
    }
    if (provider === 'meta_ads') {
      const token = await exchangeMetaCode(s.client_id, s.client_secret, code, s.redirect_uri);
      const accounts = await listAdAccounts(token).catch(() => []);
      const pages = await listPages(token).catch(() => []);
      save({ client_id: s.client_id, client_secret: s.client_secret, access_token: token, ad_account_id: accounts[0]?.id || '', page_id: pages[0]?.id || '', accounts, pages, handle: accounts[0]?.name || 'Meta ad account' });
      return back('connected');
    }
    if (provider === 'google_ads') {
      const { access_token, refresh_token } = await exchangeGoogleCode(s.client_id, s.client_secret, code, s.redirect_uri);
      // access_token is short-lived; refresh_token is what we persist + re-exchange.
      save({ client_id: s.client_id, client_secret: s.client_secret, access_token, refresh_token, developer_token: s.developer_token, customer_id: s.customer_id, login_customer_id: s.login_customer_id, handle: `Google Ads ${s.customer_id}` });
      return back('connected');
    }
    if (provider === 'reddit_ads') {
      const { access_token, refresh_token } = await exchangeRedditAdsCode(s.client_id, s.client_secret, code, s.redirect_uri);
      const accounts = await listRedditAdAccounts({ ...s, access_token, refresh_token }).catch(() => []);
      save({ client_id: s.client_id, client_secret: s.client_secret, access_token, refresh_token, ad_account_id: accounts[0]?.id || '', accounts, handle: accounts[0]?.name || 'Reddit ad account' });
      return back('connected');
    }
    return back('error');
  } catch {
    return back('error');
  }
}
