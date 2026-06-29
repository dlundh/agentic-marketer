// ---------------------------------------------------------------------------
// Google Ads API adapter (responsive search ads).
//
// REALITY: live spend requires a Google Ads **developer token** with at least
// Basic access (applied for in the Google Ads API Center — approval takes days),
// an OAuth client, and a target customer (ad) account with billing. These calls
// are written to the documented REST spec but can only be validated against a
// real, approved account — we go live together once your Google Ads access is
// approved, exactly as with Meta.
//
// Auth model differs from Meta: OAuth gives an offline **refresh token**, which
// we exchange for a short-lived access token per request. Every call also needs
// the developer-token header and the numeric customer id.
// ---------------------------------------------------------------------------

import type { AdProvider, AdIds, AdMetrics } from './adproviders';
import type { AdSpec } from './meta';

// API version is overridable — Google sunsets versions ~yearly, and a sunset
// version returns a 404 HTML page (not JSON). Bump via GOOGLE_ADS_API_VERSION.
const V = process.env.GOOGLE_ADS_API_VERSION || 'v18';
const API = `https://googleads.googleapis.com/${V}`;
const OAUTH = 'https://oauth2.googleapis.com';
export const GOOGLE_ADS_SCOPE = 'https://www.googleapis.com/auth/adwords';

const digits = (s: string) => String(s || '').replace(/\D/g, '');

// Read a response as JSON, but if Google returned HTML/non-JSON (sunset API
// version, API not enabled, an auth/redirect page…), surface a clear, actionable
// error instead of a cryptic "Unexpected token '<'" parse failure.
async function readJson(res: Response, where: string): Promise<any> {
  const text = await res.text();
  try { return JSON.parse(text); }
  catch {
    const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 160);
    const hint = res.status === 404
      ? `the Google Ads API version (${V}) may be sunset — set GOOGLE_ADS_API_VERSION to a current one`
      : res.status === 403
      ? 'the Google Ads API may not be enabled for this Cloud project, or the developer token lacks access'
      : 'check the Google Ads API is enabled and the developer token is approved';
    throw new Error(`Google Ads ${where}: HTTP ${res.status} returned a non-JSON page — ${hint}. (${snippet})`);
  }
}

function gerr(path: string, j: any, status: number): Error {
  // Google Ads surfaces the real reason under error.details[].errors[].message.
  const e = j?.error || {};
  const deep = e.details?.[0]?.errors?.[0];
  const msg = deep?.message || e.message || `HTTP ${status}`;
  return new Error(`Google Ads ${path}: ${msg}`);
}

// ---- OAuth ----------------------------------------------------------------
export function googleAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const q = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, state, response_type: 'code',
    scope: GOOGLE_ADS_SCOPE, access_type: 'offline', prompt: 'consent', // prompt=consent forces a refresh_token
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}`;
}
export async function exchangeGoogleCode(clientId: string, clientSecret: string, code: string, redirectUri: string): Promise<{ access_token: string; refresh_token: string }> {
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri, grant_type: 'authorization_code' });
  const res = await fetch(`${OAUTH}/token`, { method: 'POST', body, signal: AbortSignal.timeout(15000) });
  const j: any = await readJson(res, 'token exchange');
  if (!res.ok) throw new Error(`Google token exchange: ${j.error_description || j.error || res.status}`);
  return { access_token: j.access_token, refresh_token: j.refresh_token };
}
async function accessToken(s: any): Promise<string> {
  if (!s?.refresh_token) throw new Error('Google Ads isn’t fully connected (missing refresh token) — reconnect.');
  const body = new URLSearchParams({ client_id: s.client_id, client_secret: s.client_secret, refresh_token: s.refresh_token, grant_type: 'refresh_token' });
  const res = await fetch(`${OAUTH}/token`, { method: 'POST', body, signal: AbortSignal.timeout(15000) });
  const j: any = await readJson(res, 'token refresh');
  if (!res.ok) throw new Error(`Google token refresh: ${j.error_description || j.error || res.status}`);
  return j.access_token;
}
function headers(token: string, s: any): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'developer-token': s.developer_token || '',
    'Content-Type': 'application/json',
  };
  // login-customer-id is the manager (MCC) account, if the target is managed by one.
  if (s.login_customer_id) h['login-customer-id'] = digits(s.login_customer_id);
  return h;
}
async function mutate(s: any, token: string, resource: string, operations: any[]): Promise<string> {
  const cid = digits(s.customer_id);
  const res = await fetch(`${API}/customers/${cid}/${resource}:mutate`, {
    method: 'POST', headers: headers(token, s), body: JSON.stringify({ operations }), signal: AbortSignal.timeout(20000),
  });
  const j: any = await readJson(res, `${resource}:mutate`);
  if (!res.ok || j.error) throw gerr(resource, j, res.status);
  return j.results?.[0]?.resourceName || '';
}

// List customers the OAuth'd user can access (numeric ids), for the picker.
export async function listGoogleCustomers(s: any): Promise<string[]> {
  const token = await accessToken(s);
  const res = await fetch(`${API}/customers:listAccessibleCustomers`, { headers: headers(token, s), signal: AbortSignal.timeout(15000) });
  const j: any = await readJson(res, 'listAccessibleCustomers');
  if (!res.ok || j.error) throw gerr('listAccessibleCustomers', j, res.status);
  return (j.resourceNames || []).map((r: string) => r.split('/')[1]);
}

// Build the 3+ headlines / 2+ descriptions a responsive search ad requires.
function rsaText(spec: AdSpec): { headlines: { text: string }[]; descriptions: { text: string }[] } {
  const clip = (t: string, n: number) => t.replace(/\s+/g, ' ').trim().slice(0, n);
  let heads = (spec.headlines?.length ? spec.headlines : [spec.headline, spec.name, spec.message])
    .filter(Boolean).map((t) => clip(t!, 30));
  let descs = (spec.descriptions?.length ? spec.descriptions : [spec.description, spec.message, spec.headline])
    .filter(Boolean).map((t) => clip(t!, 90));
  heads = [...new Set(heads)]; descs = [...new Set(descs)];
  if (heads.length < 3) throw new Error('Google search ads need at least 3 distinct headlines (≤30 chars). Add `headlines` to the action.');
  if (descs.length < 2) throw new Error('Google search ads need at least 2 distinct descriptions (≤90 chars). Add `descriptions` to the action.');
  return { headlines: heads.slice(0, 15).map((text) => ({ text })), descriptions: descs.slice(0, 4).map((text) => ({ text })) };
}

// Parse an app store id + store enum from a store URL (for App campaigns).
//   apps.apple.com/.../id1234567890   → { appId: '1234567890', store: 'APPLE_APP_STORE' }
//   play.google.com/store/apps/details?id=com.foo.bar → { appId: 'com.foo.bar', store: 'GOOGLE_APP_STORE' }
export function parseAppStoreUrl(url: string): { appId: string; store: 'APPLE_APP_STORE' | 'GOOGLE_APP_STORE' } | null {
  if (!url) return null;
  const ios = url.match(/apps\.apple\.com\/.*\/id(\d+)/i) || url.match(/itunes\.apple\.com\/.*\/id(\d+)/i);
  if (ios) return { appId: ios[1], store: 'APPLE_APP_STORE' };
  const play = url.match(/play\.google\.com\/store\/apps\/details\?.*\bid=([\w.]+)/i);
  if (play) return { appId: play[1], store: 'GOOGLE_APP_STORE' };
  return null;
}

// Create a PAUSED campaign of the right TYPE for what's being marketed:
//   • objective 'app'  → App campaign (drives installs from the store listing)
//   • otherwise        → Search campaign with a responsive search ad to a website
export async function launchGoogleAd(s: any, spec: AdSpec): Promise<AdIds> {
  const token = await accessToken(s);
  const cid = digits(s.customer_id);
  if (!cid) throw new Error('Set your Google Ads customer id under ⚙ Channels.');
  if (!s.developer_token) throw new Error('Set your Google Ads developer token under ⚙ Channels.');
  const micros = spec.dailyBudgetCents * 10_000; // 1 currency unit = 1e6 micros; 1 cent = 1e4 micros
  const stamp = spec.name.slice(0, 60);

  const budget = await mutate(s, token, 'campaignBudgets', [{ create: {
    name: `${stamp} — budget`, amountMicros: String(micros), deliveryMethod: 'STANDARD', explicitlyShared: false,
  } }]);

  // ---- App campaign (mobile app installs) ----
  if (s.objective === 'app') {
    if (!s.app_id) throw new Error('App campaign needs the app’s store ID — set it under ⚙ Channels → Google Ads.');
    const appStore = s.app_store === 'APPLE_APP_STORE' || s.app_store === 'GOOGLE_APP_STORE'
      ? s.app_store : (/^\d+$/.test(String(s.app_id)) ? 'APPLE_APP_STORE' : 'GOOGLE_APP_STORE');
    const campaign = await mutate(s, token, 'campaigns', [{ create: {
      name: stamp, status: 'PAUSED', advertisingChannelType: 'MULTI_CHANNEL', advertisingChannelSubType: 'APP_CAMPAIGN',
      campaignBudget: budget,
      appCampaignSetting: { appId: String(s.app_id), appStore, biddingStrategyGoalType: 'OPTIMIZE_INSTALLS_WITHOUT_TARGET_INSTALL_COST' },
    } }]);
    try {
      const adGroup = await mutate(s, token, 'adGroups', [{ create: { name: `${stamp} — ad group`, campaign, status: 'ENABLED' } }]);
      const { headlines, descriptions } = rsaText(spec); // app ads take ≤5 of each
      const adGroupAd = await mutate(s, token, 'adGroupAds', [{ create: {
        adGroup, status: 'PAUSED', ad: { appAd: { headlines: headlines.slice(0, 5), descriptions: descriptions.slice(0, 5) } },
      } }]);
      return { campaignId: campaign, adsetId: adGroup, adId: adGroupAd, budgetId: budget };
    } catch (e) {
      try { await mutate(s, token, 'campaigns', [{ remove: campaign }]); } catch { /* best effort cleanup */ }
      throw e;
    }
  }

  // ---- Search campaign (website traffic) — default ----
  const campaign = await mutate(s, token, 'campaigns', [{ create: {
    name: stamp, status: 'PAUSED', advertisingChannelType: 'SEARCH', campaignBudget: budget,
    manualCpc: {}, networkSettings: { targetGoogleSearch: true, targetSearchNetwork: true, targetContentNetwork: false },
  } }]);
  try {
    const adGroup = await mutate(s, token, 'adGroups', [{ create: {
      name: `${stamp} — ad group`, campaign, status: 'ENABLED', type: 'SEARCH_STANDARD', cpcBidMicros: String(1_000_000),
    } }]);
    const { headlines, descriptions } = rsaText(spec);
    const adGroupAd = await mutate(s, token, 'adGroupAds', [{ create: {
      adGroup, status: 'PAUSED', ad: { finalUrls: [spec.link], responsiveSearchAd: { headlines, descriptions } },
    } }]);
    // campaignId we store is the resource name (used for status/remove + reporting).
    return { campaignId: campaign, adsetId: adGroup, adId: adGroupAd, budgetId: budget };
  } catch (e) {
    try { await mutate(s, token, 'campaigns', [{ remove: campaign }]); } catch { /* best effort cleanup */ }
    throw e;
  }
}

export async function setGoogleStatus(s: any, ids: AdIds, status: 'ENABLED' | 'PAUSED') {
  const token = await accessToken(s);
  if (ids.campaignId) await mutate(s, token, 'campaigns', [{ update: { resourceName: ids.campaignId, status }, updateMask: 'status' }]);
}
export async function removeGoogleAd(s: any, ids: AdIds) {
  const token = await accessToken(s);
  if (ids.campaignId) await mutate(s, token, 'campaigns', [{ remove: ids.campaignId }]);
}
export async function googleInsights(s: any, ids: AdIds): Promise<AdMetrics> {
  if (!ids.campaignId) return { spendCents: 0, impressions: 0, clicks: 0, conversions: 0 };
  const token = await accessToken(s);
  const cid = digits(s.customer_id);
  const query = `SELECT metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions FROM campaign WHERE campaign.resource_name = '${ids.campaignId}'`;
  const res = await fetch(`${API}/customers/${cid}/googleAds:search`, {
    method: 'POST', headers: headers(token, s), body: JSON.stringify({ query }), signal: AbortSignal.timeout(20000),
  });
  const j: any = await readJson(res, 'googleAds:search');
  if (!res.ok || j.error) throw gerr('googleAds:search', j, res.status);
  const m = j.results?.[0]?.metrics || {};
  // For App campaigns conversions = installs (with conversion tracking configured).
  return { spendCents: Math.round(Number(m.costMicros || 0) / 10_000), impressions: +(m.impressions || 0), clicks: +(m.clicks || 0), conversions: +(m.conversions || 0) };
}

export const googleProvider: AdProvider = {
  key: 'google_ads', label: 'Google Ads',
  launch: (s, spec) => launchGoogleAd(s, spec),
  setStatus: (s, ids, status) => setGoogleStatus(s, ids, status === 'ACTIVE' ? 'ENABLED' : 'PAUSED'),
  remove: (s, ids) => removeGoogleAd(s, ids),
  insights: (s, ids) => googleInsights(s, ids),
};
