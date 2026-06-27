// ---------------------------------------------------------------------------
// Meta (Facebook/Instagram) Marketing API adapter.
//
// REALITY: live spend requires the app owner's Meta app to pass App Review +
// Business Verification and hold ADVANCED access to `ads_management`, plus an
// ad account with a payment method. These calls are written to spec but can
// only be validated against a real, approved ad account — we go live together
// once your Meta access is approved.
// ---------------------------------------------------------------------------

const V = 'v23.0';
const GRAPH = `https://graph.facebook.com/${V}`;
const SCOPES = 'ads_management,ads_read,business_management,pages_show_list';

// Surface Meta's full error detail — the generic "Invalid parameter" hides the
// real reason in error_user_msg / error_subcode / fbtrace_id.
function metaError(path: string, j: any, status: number): Error {
  const e = j?.error || {};
  const parts = [e.message || `HTTP ${status}`];
  if (e.error_user_title && e.error_user_title !== e.message) parts.push(e.error_user_title);
  if (e.error_user_msg) parts.push(e.error_user_msg);
  if (e.error_subcode) parts.push(`subcode ${e.error_subcode}`);
  if (e.fbtrace_id) parts.push(`trace ${e.fbtrace_id}`);
  return new Error(`Meta ${path}: ${parts.join(' — ')}`);
}
async function gget(path: string, params: Record<string, string>) {
  const url = `${GRAPH}${path}?${new URLSearchParams(params).toString()}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const j: any = await res.json();
  if (!res.ok || j.error) throw metaError(path, j, res.status);
  return j;
}
async function gpost(path: string, token: string, body: Record<string, any>) {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) form.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  form.set('access_token', token);
  const res = await fetch(`${GRAPH}${path}`, { method: 'POST', body: form, signal: AbortSignal.timeout(15000) });
  const j: any = await res.json();
  if (!res.ok || j.error) throw metaError(path, j, res.status);
  return j;
}
async function gdelete(id: string, token: string) {
  try { await fetch(`${GRAPH}/${id}?access_token=${encodeURIComponent(token)}`, { method: 'DELETE', signal: AbortSignal.timeout(10000) }); } catch { /* best effort */ }
}
export async function deleteMetaEntity(token: string, id: string) { await gdelete(id, token); }

// ---- OAuth ----------------------------------------------------------------
export function metaAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, state, response_type: 'code', scope: SCOPES });
  return `https://www.facebook.com/${V}/dialog/oauth?${q.toString()}`;
}
export async function exchangeMetaCode(clientId: string, clientSecret: string, code: string, redirectUri: string): Promise<string> {
  const short = await gget('/oauth/access_token', { client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, code });
  // Upgrade to a long-lived (~60d) token.
  const long = await gget('/oauth/access_token', { grant_type: 'fb_exchange_token', client_id: clientId, client_secret: clientSecret, fb_exchange_token: short.access_token });
  return long.access_token || short.access_token;
}
export async function listAdAccounts(token: string): Promise<{ id: string; name: string }[]> {
  const j = await gget('/me/adaccounts', { access_token: token, fields: 'account_id,name' });
  return (j.data || []).map((a: any) => ({ id: a.account_id, name: a.name }));
}
export async function listPages(token: string): Promise<{ id: string; name: string }[]> {
  const j = await gget('/me/accounts', { access_token: token, fields: 'id,name' });
  return (j.data || []).map((p: any) => ({ id: p.id, name: p.name }));
}

// ---- Campaign structure ---------------------------------------------------
export type AdSpec = {
  name: string; objective?: string; dailyBudgetCents: number;
  message: string; headline: string; description?: string; link: string;
  imageUrl?: string; cta?: string;
  countries?: string[]; ageMin?: number; ageMax?: number; interests?: string[];
};

// Create a PAUSED campaign → ad set → link-ad-creative → ad. Returns ids.
// Created PAUSED so nothing spends until explicitly activated.
export async function launchMetaAd(token: string, actId: string, pageId: string, spec: AdSpec) {
  const act = `act_${actId.replace(/^act_/, '')}`;
  const campaign = await gpost(`/${act}/campaigns`, token, {
    name: spec.name, objective: spec.objective || 'OUTCOME_TRAFFIC', status: 'PAUSED',
    special_ad_categories: [],
    // Required when budgets live on ad sets (not the campaign). false = each ad
    // set's daily budget stays strict, which our daily-cap accounting relies on.
    is_adset_budget_sharing_enabled: false,
  });
  try {
    const targeting: any = { geo_locations: { countries: spec.countries?.length ? spec.countries : ['US'] } };
    if (spec.ageMin) targeting.age_min = spec.ageMin;
    if (spec.ageMax) targeting.age_max = spec.ageMax;
    if (spec.interests?.length) targeting.flexible_spec = [{ interests: spec.interests.map((i) => ({ name: i })) }];
    const adset = await gpost(`/${act}/adsets`, token, {
      name: `${spec.name} — ad set`, campaign_id: campaign.id, status: 'PAUSED',
      daily_budget: String(spec.dailyBudgetCents), billing_event: 'IMPRESSIONS',
      optimization_goal: 'LINK_CLICKS', bid_strategy: 'LOWEST_COST_WITHOUT_CAP', targeting,
    });
    const creative = await gpost(`/${act}/adcreatives`, token, {
      name: `${spec.name} — creative`,
      object_story_spec: {
        page_id: pageId,
        link_data: {
          message: spec.message, link: spec.link, name: spec.headline,
          description: spec.description || '', picture: spec.imageUrl || undefined,
          call_to_action: { type: spec.cta || 'LEARN_MORE', value: { link: spec.link } },
        },
      },
    });
    const ad = await gpost(`/${act}/ads`, token, {
      name: `${spec.name} — ad`, adset_id: adset.id, creative: { creative_id: creative.id }, status: 'PAUSED',
    });
    return { campaignId: campaign.id, adsetId: adset.id, creativeId: creative.id, adId: ad.id };
  } catch (e) {
    await gdelete(campaign.id, token); // remove the orphaned paused campaign so retries don't pile up
    throw e;
  }
}

// Flip an entity (campaign/adset/ad) ACTIVE or PAUSED.
export async function setMetaStatus(token: string, id: string, status: 'ACTIVE' | 'PAUSED') {
  return gpost(`/${id}`, token, { status });
}
export async function setAdSetDailyBudget(token: string, adsetId: string, cents: number) {
  return gpost(`/${adsetId}`, token, { daily_budget: String(cents) });
}
// Total spend (cents) + key metrics for a campaign, lifetime.
export async function campaignInsights(token: string, campaignId: string): Promise<{ spendCents: number; impressions: number; clicks: number }> {
  const j = await gget(`/${campaignId}/insights`, { access_token: token, fields: 'spend,impressions,clicks', date_preset: 'maximum' });
  const row = (j.data || [])[0] || {};
  return { spendCents: Math.round(parseFloat(row.spend || '0') * 100), impressions: +(row.impressions || 0), clicks: +(row.clicks || 0) };
}
