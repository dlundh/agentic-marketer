// ---------------------------------------------------------------------------
// Reddit Ads API adapter (v3).
//
// REALITY: the Reddit Ads API is approval-gated — you need a Reddit Ads account
// in good standing and API access granted by Reddit, plus an OAuth app with the
// `adsread`/`adsedit` scopes. These calls follow the documented v3 shape but can
// only be validated against a real, approved ad account — we go live together
// once your Reddit Ads access is approved, exactly as with Meta.
//
// Reddit ads promote a link post: campaign → ad group (carries the budget +
// schedule) → ad (the creative: headline + link + optional thumbnail).
// ---------------------------------------------------------------------------

import type { AdProvider, AdIds, AdMetrics } from './adproviders';
import type { AdSpec } from './meta';

const API = 'https://ads-api.reddit.com/api/v3';
const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const UA = 'agentic-marketer/0.1 (ads)';
export const REDDIT_ADS_SCOPE = 'adsread adsedit identity';

async function rerr(path: string, res: Response): Promise<Error> {
  let detail = `HTTP ${res.status}`;
  try { const j: any = await res.json(); detail = j?.error?.message || j?.message || JSON.stringify(j).slice(0, 200); } catch { /* non-json */ }
  return new Error(`Reddit Ads ${path}: ${detail}`);
}

// ---- OAuth (Reddit's standard flow, with ads scopes) ----------------------
export function redditAdsAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const q = new URLSearchParams({
    client_id: clientId, response_type: 'code', state, redirect_uri: redirectUri,
    duration: 'permanent', scope: REDDIT_ADS_SCOPE, // permanent => refresh token
  });
  return `https://www.reddit.com/api/v1/authorize?${q.toString()}`;
}
export async function exchangeRedditAdsCode(clientId: string, clientSecret: string, code: string, redirectUri: string): Promise<{ access_token: string; refresh_token: string }> {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  const res = await fetch(TOKEN_URL, { method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA }, body, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw await rerr('token', res);
  const j: any = await res.json();
  return { access_token: j.access_token, refresh_token: j.refresh_token };
}
async function accessToken(s: any): Promise<string> {
  if (!s?.refresh_token) throw new Error('Reddit Ads isn’t fully connected (missing refresh token) — reconnect.');
  const basic = Buffer.from(`${s.client_id}:${s.client_secret}`).toString('base64');
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: s.refresh_token });
  const res = await fetch(TOKEN_URL, { method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA }, body, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw await rerr('token refresh', res);
  const j: any = await res.json();
  return j.access_token;
}
async function rfetch(s: any, token: string, method: string, path: string, body?: any): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': UA },
    body: body ? JSON.stringify({ data: body }) : undefined, signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw await rerr(path, res);
  return res.json();
}

// Ad accounts the user can manage, for the picker.
export async function listRedditAdAccounts(s: any): Promise<{ id: string; name: string }[]> {
  const token = await accessToken(s);
  const j = await rfetch(s, token, 'GET', '/me/ad_accounts');
  return (j.data || []).map((a: any) => ({ id: a.id, name: a.name || a.id }));
}

// Create a PAUSED campaign → ad group (budget) → ad (creative).
export async function launchRedditAd(s: any, spec: AdSpec): Promise<AdIds> {
  const acct = s.ad_account_id;
  if (!acct) throw new Error('Pick your Reddit ad account under ⚙ Channels first.');
  const token = await accessToken(s);
  const name = spec.name.slice(0, 80);

  const campaign = await rfetch(s, token, 'POST', `/ad_accounts/${acct}/campaigns`, {
    name, objective: 'TRAFFIC', configured_status: 'PAUSED',
  });
  const campaignId = campaign.data?.id;
  try {
    const adGroup = await rfetch(s, token, 'POST', `/ad_accounts/${acct}/ad_groups`, {
      campaign_id: campaignId, name: `${name} — ad group`, configured_status: 'PAUSED',
      bid_strategy: 'MAXIMIZE_VOLUME', goal_type: 'DAILY_SPEND', goal_value: spec.dailyBudgetCents * 10_000, // micros
    });
    const adGroupId = adGroup.data?.id;
    const ad = await rfetch(s, token, 'POST', `/ad_accounts/${acct}/ads`, {
      ad_group_id: adGroupId, name: `${name} — ad`, configured_status: 'PAUSED',
      type: 'LINK', headline: (spec.headline || name).slice(0, 300),
      destination_url: spec.link, thumbnail_url: spec.imageUrl || undefined,
    });
    return { campaignId, adsetId: adGroupId, adId: ad.data?.id };
  } catch (e) {
    try { await rfetch(s, token, 'DELETE', `/ad_accounts/${acct}/campaigns/${campaignId}`); } catch { /* best effort */ }
    throw e;
  }
}

export async function setRedditStatus(s: any, ids: AdIds, status: 'ACTIVE' | 'PAUSED') {
  const acct = s.ad_account_id; const token = await accessToken(s);
  if (ids.campaignId) await rfetch(s, token, 'PATCH', `/ad_accounts/${acct}/campaigns/${ids.campaignId}`, { configured_status: status });
}
export async function removeRedditAd(s: any, ids: AdIds) {
  const acct = s.ad_account_id; const token = await accessToken(s);
  if (ids.campaignId) await rfetch(s, token, 'DELETE', `/ad_accounts/${acct}/campaigns/${ids.campaignId}`);
}
export async function redditInsights(s: any, ids: AdIds): Promise<AdMetrics> {
  if (!ids.campaignId) return { spendCents: 0, impressions: 0, clicks: 0 };
  const acct = s.ad_account_id; const token = await accessToken(s);
  // Lifetime metrics for the campaign.
  const j = await rfetch(s, token, 'POST', `/ad_accounts/${acct}/reports`, {
    breakdowns: ['CAMPAIGN_ID'], fields: ['spend', 'impressions', 'clicks'], time_zone_id: 'GMT',
    filters: [{ filter: 'CAMPAIGN_ID', operator: 'EQUALS', values: [ids.campaignId] }],
  });
  const row = (j.data?.metrics || j.data || [])[0] || {};
  return { spendCents: Math.round(Number(row.spend || 0) / 10_000), impressions: +(row.impressions || 0), clicks: +(row.clicks || 0) };
}

export const redditAdsProvider: AdProvider = {
  key: 'reddit_ads', label: 'Reddit Ads',
  launch: (s, spec) => launchRedditAd(s, spec),
  setStatus: (s, ids, status) => setRedditStatus(s, ids, status),
  remove: (s, ids) => removeRedditAd(s, ids),
  insights: (s, ids) => redditInsights(s, ids),
};
