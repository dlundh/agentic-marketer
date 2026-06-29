import nodemailer from 'nodemailer';
import { getConnector, upsertConnector, activeRecipients, getProject, adImageUrls, type ActionRow, type Connector, type Recipient } from './db';
import { postMastodon, postX, refreshX, postReddit, refreshReddit, postLinkedin, postRedditComment, tweetIdFromUrl, mastodonIdFromUrl, redditParentFromUrl } from './oauth';
import type { AdSpec } from './meta';
import { isAdChannel, adProvider } from './adproviders';
import { parseAppStoreUrl } from './google';

// ---------------------------------------------------------------------------
// Channel catalog + execution adapters.
//
// Reality: most platforms (X, LinkedIn, Meta/Google Ads, …) require the user's
// own OAuth'd accounts and, for ads, business verification. Rather than fake
// that, every channel resolves to one of three executors when an action is
// approved:
//   • smtp    — real email send (outreach / influencer / lifecycle) via SMTP
//   • webhook — POST the action to the user's automation hook (Zapier / Make /
//               n8n / Buffer), the practical bridge to "every tool". Connect a
//               per-channel hook, or one global hook used as a fallback.
//   • manual  — no executor connected: the action is marked publish-ready with
//               copy-paste content. Nothing is faked as "posted".
// ---------------------------------------------------------------------------

export type ChannelCategory = 'organic' | 'community' | 'email' | 'paid' | 'influencer' | 'content' | 'automation';
export type ChannelDef = {
  key: string; label: string; category: ChannelCategory; executor: 'webhook' | 'smtp' | 'manual';
  paid?: boolean; note?: string;
};

export const CHANNELS: ChannelDef[] = [
  { key: 'webhook', label: 'Automation webhook (Zapier / Make / n8n / Buffer)', category: 'automation', executor: 'webhook', note: 'Catch-all fallback: approved actions for channels without a native connection are POSTed here (with a channel field) for your automation to route. 200 = delivered, not confirmed live.' },
  { key: 'smtp', label: 'Email (SMTP)', category: 'email', executor: 'smtp', note: 'Sends approved outreach/lifecycle emails. Opt-out footer enforced.' },

  { key: 'x', label: 'X / Twitter', category: 'organic', executor: 'webhook' },
  { key: 'linkedin', label: 'LinkedIn', category: 'organic', executor: 'webhook' },
  { key: 'reddit', label: 'Reddit', category: 'community', executor: 'webhook' },
  { key: 'instagram', label: 'Instagram', category: 'organic', executor: 'webhook' },
  { key: 'tiktok', label: 'TikTok', category: 'organic', executor: 'webhook' },
  { key: 'facebook', label: 'Facebook', category: 'organic', executor: 'webhook' },
  { key: 'youtube', label: 'YouTube', category: 'organic', executor: 'webhook' },
  { key: 'mastodon', label: 'Mastodon', category: 'organic', executor: 'webhook' },
  { key: 'threads', label: 'Threads', category: 'organic', executor: 'webhook' },
  { key: 'discord', label: 'Discord', category: 'community', executor: 'webhook' },
  { key: 'hackernews', label: 'Hacker News', category: 'community', executor: 'manual' },
  { key: 'producthunt', label: 'Product Hunt', category: 'community', executor: 'manual' },
  { key: 'indiehackers', label: 'Indie Hackers', category: 'community', executor: 'manual' },

  { key: 'blog', label: 'Blog / SEO content', category: 'content', executor: 'webhook' },

  { key: 'email', label: 'Email outreach', category: 'email', executor: 'smtp' },
  { key: 'influencer', label: 'Influencer / creator outreach', category: 'influencer', executor: 'smtp' },

  { key: 'meta_ads', label: 'Meta Ads', category: 'paid', executor: 'webhook', paid: true, note: 'Autonomous Meta (Facebook/Instagram) ad spend. Needs Business Verification + App Review for ads_management and an ad account with billing.' },
  { key: 'google_ads', label: 'Google Ads', category: 'paid', executor: 'webhook', paid: true, note: 'Autonomous Google search-ad spend. Needs a Google Ads API developer token (Basic access) + your customer id, plus an account with billing. Written to spec — validate live once your token is approved.' },
  { key: 'reddit_ads', label: 'Reddit Ads', category: 'paid', executor: 'webhook', paid: true, note: 'Autonomous Reddit ad spend. Reddit Ads API access is approval-gated. Written to spec — validate live once Reddit grants API access to your ad account.' },
  { key: 'tiktok_ads', label: 'TikTok Ads', category: 'paid', executor: 'webhook', paid: true },
  { key: 'x_ads', label: 'X Ads', category: 'paid', executor: 'webhook', paid: true },
];

export const channelDef = (key: string): ChannelDef =>
  CHANNELS.find((c) => c.key === key) || { key, label: key, category: 'content', executor: 'manual' };

// Strip "AI slop" — scaffolding labels the model sometimes bakes into the body
// copy (e.g. "Primary text:", "Headline:", "CTA:", "Final URL:") — so we never
// publish them. Unwraps a mislabeled body (keeps the text after the label) and,
// for ads, drops pure structural-metadata lines that belong in their own fields.
const BODY_LABEL = /^\s*(?:[-*•]\s*)?(primary text|body copy|body|caption|ad copy|copy|post|tweet|thread|message|hook|headline|sub-?headline)\s*:\s+/i;
const META_LINE = /^\s*(?:[-*•>]\s*)?(final url|destination url|display path|landing page|cta|call[- ]to[- ]action|headlines?|descriptions?|sitelinks?|primary text|character count|char(?:acter)? limit|image|format|notes?)\s*[:(]/i;
export function cleanCopy(text?: string | null, isAd = false): string {
  if (!text) return '';
  let lines = String(text).split('\n');
  // Unwrap a mislabeled body: first line always, every line for ads.
  lines = lines.map((l, i) => (i === 0 || isAd ? l.replace(BODY_LABEL, '') : l));
  if (isAd) lines = lines.filter((l) => !META_LINE.test(l)); // drop structural notes
  return lines.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function seedConnectors(projectId: string) {
  for (const ch of CHANNELS) {
    if (!getConnector(projectId, ch.key)) {
      upsertConnector(projectId, { key: ch.key, label: ch.label, executor: ch.executor, connected: false });
    }
  }
}

// Replace {{name}} / {{first_name}} / {{company}} / {{email}} tokens per recipient.
function personalize(text: string, r: { email: string; name?: string | null; company?: string | null }): string {
  const first = (r.name || '').trim().split(/\s+/)[0] || '';
  return (text || '')
    .replace(/\{\{\s*first_name\s*\}\}/gi, first)
    .replace(/\{\{\s*name\s*\}\}/gi, (r.name || '').trim())
    .replace(/\{\{\s*company\s*\}\}/gi, (r.company || '').trim())
    .replace(/\{\{\s*email\s*\}\}/gi, r.email);
}
function unsubFooter(projectId: string, email: string): string {
  const link = `${APP_BASE}/api/unsubscribe?p=${projectId}&e=${encodeURIComponent(email)}`;
  return `\n\n—\nYou received this because we think it's genuinely relevant to you. Unsubscribe: ${link}  (or simply reply "unsubscribe").`;
}

async function sendEmail(smtp: Connector, action: ActionRow): Promise<{ status: string; detail: string }> {
  const cfg = JSON.parse(smtp.secrets || '{}');
  const meta = action.meta ? JSON.parse(action.meta) : {};
  const transport = nodemailer.createTransport({
    host: cfg.host, port: Number(cfg.port) || 587,
    secure: cfg.secure ?? Number(cfg.port) === 465,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
  });
  const from = cfg.from || cfg.user;
  const subjectTpl = meta.subject || action.title;
  const bodyTpl = action.content || action.summary || '';

  // Build the recipient set: a saved list (preferred) or manually-specified addresses.
  let recips: Recipient[];
  if (meta.list_id) {
    recips = activeRecipients(meta.list_id, action.project_id);
    if (!recips.length) return { status: 'ready', detail: 'The selected list has no active recipients (empty, or everyone unsubscribed).' };
  } else {
    const to: string[] = ([] as string[]).concat(meta.to || meta.recipients || []).map((e: string) => String(e).trim().toLowerCase()).filter(Boolean);
    if (!to.length) return { status: 'ready', detail: 'Approved — choose an email list (or add recipients) to send this.' };
    recips = to.map((email) => ({ email } as Recipient));
  }

  let sent = 0, failed = 0;
  for (const r of recips) {
    try {
      await transport.sendMail({
        from, to: r.email,
        subject: personalize(subjectTpl, r),
        text: personalize(bodyTpl, r) + unsubFooter(action.project_id, r.email),
      });
      sent++;
    } catch { failed++; }
  }
  if (!sent) return { status: 'failed', detail: `Could not send to any of the ${recips.length} recipient(s) — check SMTP settings.` };
  return { status: 'done', detail: `Sent to ${sent} recipient(s)${failed ? ` (${failed} failed)` : ''}.` };
}

const APP_BASE = process.env.APP_BASE_URL || 'http://localhost:4400';

async function postWebhook(url: string, action: ActionRow): Promise<{ status: string; detail: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: action.id, channel: action.channel, kind: action.kind, title: action.title,
      summary: action.summary, content: action.content,
      meta: action.meta ? JSON.parse(action.meta) : null,
      cost_usd: action.cost_cents / 100,
      // Your Zap/scenario can POST the result back here to confirm it went live.
      callback_url: `${APP_BASE}/api/actions/${action.id}/result`,
    }),
  });
  if (!res.ok) throw new Error(`webhook responded ${res.status}`);
  // "sent" (not "done"): delivered to the automation, but not yet confirmed live.
  return { status: 'sent', detail: `Sent to your automation (HTTP ${res.status}). Awaiting confirmation it went live — add the callback step to your Zap for a confirmed link.` };
}

const safeJSON = (s: string | null) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

// The set of channel keys that can auto-publish right now (connected natively,
// via a per-channel webhook, the global webhook, or SMTP). Drives swarm scoping.
export function autoChannels(projectId: string): string[] {
  const webhookOn = !!getConnector(projectId, 'webhook')?.connected;
  const smtpOn = !!getConnector(projectId, 'smtp')?.connected;
  const keys: string[] = [];
  for (const ch of CHANNELS) {
    if (ch.key === 'webhook' || ch.key === 'smtp') continue;
    const own = getConnector(projectId, ch.key);
    if (own?.excluded) continue; // user opted this channel out of action generation
    const s = own?.connected ? safeJSON(own.secrets) : null;
    const native = ['mastodon', 'x', 'reddit', 'linkedin', 'meta_ads', 'google_ads', 'reddit_ads'].includes(ch.key) && s?.access_token;
    const ownHook = !!s?.url;
    const viaWebhook = webhookOn && ch.executor === 'webhook';
    const viaSmtp = smtpOn && ch.executor === 'smtp';
    if (native || ownHook || viaWebhook || viaSmtp) keys.push(ch.key);
  }
  return keys;
}

// Will approving this action actually publish it automatically (vs. need a
// manual human step)? Used to gate Approve and to hide manual-only actions.
export function isAutoExecutable(action: ActionRow): boolean {
  if (action.kind === 'account') return false; // account creation is always human
  const def = channelDef(action.channel);
  const own = getConnector(action.project_id, action.channel);
  const ownSecrets = own?.connected ? safeJSON(own.secrets) : null;
  if (['mastodon', 'x', 'reddit', 'linkedin', 'meta_ads', 'google_ads', 'reddit_ads'].includes(action.channel) && ownSecrets?.access_token) return true; // native API
  if (ownSecrets?.url) return true; // per-channel webhook
  const emailish = def.executor === 'smtp' || ['email', 'outreach'].includes(action.kind);
  if (emailish && getConnector(action.project_id, 'smtp')?.connected) return true; // SMTP
  if (getConnector(action.project_id, 'webhook')?.connected) return true; // automation webhook
  return false;
}

// Find the target subreddit for a Reddit action (meta, targeting, or content).
function subredditOf(action: ActionRow): string | null {
  const meta = safeJSON(action.meta) || {};
  if (meta.subreddit) return String(meta.subreddit).replace(/^\/?r\//i, '');
  const m = `${meta.targeting || ''} ${action.title} ${action.content || ''}`.match(/\br\/([A-Za-z0-9_]{2,30})\b/);
  return m ? m[1] : null;
}

// Run a post; on auth failure, refresh the token once, persist it, and retry.
async function withRefresh(projectId: string, channel: string, secrets: any, label: string, doPost: (token: string) => Promise<any>) {
  try {
    return await doPost(secrets.access_token);
  } catch (e) {
    if (!secrets.refresh_token) throw e;
    const t = channel === 'x'
      ? await refreshX(secrets.client_id, secrets.client_secret, secrets.refresh_token)
      : await refreshReddit(secrets.client_id, secrets.client_secret, secrets.refresh_token);
    const merged = { ...secrets, ...t };
    upsertConnector(projectId, { key: channel, label, executor: channel, connected: true, secrets: merged });
    return await doPost(merged.access_token);
  }
}

// Verify a posting webhook by sending a clearly-marked test ping. We only mark a
// connector "connected" if it actually works — no fake "connected" states.
export async function pingWebhook(url: string): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'connection_test', source: 'agentic-marketer', ts: Date.now() }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return { ok: true, message: `Webhook verified (HTTP ${res.status}). A test ping was sent — your automation should ignore type:"connection_test".` };
    return { ok: false, message: `That URL returned HTTP ${res.status}. Double-check the webhook URL.` };
  } catch (e: any) {
    return { ok: false, message: `Could not reach that URL: ${e?.message || e}` };
  }
}

// Verify SMTP credentials by actually authenticating with the server.
export async function verifySmtp(secrets: any): Promise<{ ok: boolean; message: string }> {
  try {
    const t = nodemailer.createTransport({
      host: secrets.host, port: Number(secrets.port) || 587,
      secure: secrets.secure ?? Number(secrets.port) === 465,
      auth: secrets.user ? { user: secrets.user, pass: secrets.pass } : undefined,
    });
    await t.verify();
    return { ok: true, message: 'SMTP verified — credentials authenticate.' };
  } catch (e: any) {
    return { ok: false, message: `SMTP check failed: ${e?.message || e}` };
  }
}

// Execute an approved action via the best available connected executor.
export async function runAction(action: ActionRow): Promise<{ status: 'done' | 'ready' | 'failed' | 'sent'; detail: string; store?: any }> {
  // Account-setup tasks are always a human step — never auto-executed.
  if (action.kind === 'account') {
    const url = safeJSON(action.meta)?.signup_url;
    return { status: 'ready', detail: `Brand-account kit ready. Create the account${url ? ` at ${url}` : ' via the signup link below'}, then Connect it under ⚙ Channels.` };
  }
  const def = channelDef(action.channel);
  const emailish = def.executor === 'smtp' || ['email', 'outreach'].includes(action.kind);
  const own = getConnector(action.project_id, action.channel);
  const ownSecrets = own?.connected ? safeJSON(own.secrets) : null;
  const smtp = getConnector(action.project_id, 'smtp');
  const hook = getConnector(action.project_id, 'webhook');

  try {
    // Native API adapters: post directly via the platform (no webhook needed).
    const text = cleanCopy(action.content || action.summary || action.title, action.kind === 'ad');

    // Community-listening reply: post `content` as a reply/comment on a specific
    // existing post (found by the engagement agent), via the channel's API.
    if (action.kind === 'reply') {
      const m = safeJSON(action.meta) || {};
      const url = String(m.reply_to_url || '').trim();
      if (!url) return { status: 'ready', detail: 'This reply has no target post URL — add the post to reply to, then approve.' };
      if (!ownSecrets?.access_token) return { status: 'ready', detail: `Connect ${def.label} under ⚙ Channels to post this reply.` };
      if (action.channel === 'x') {
        const id = tweetIdFromUrl(url);
        if (!id) return { status: 'failed', detail: `Couldn't read the tweet id from ${url}.` };
        const r = await withRefresh(action.project_id, 'x', ownSecrets, def.label, (tok) => postX(tok, text, id));
        return { status: 'done', detail: `Replied on X${r.url ? `: ${r.url}` : ''}` };
      }
      if (action.channel === 'mastodon' && ownSecrets.instance) {
        const id = mastodonIdFromUrl(url);
        if (!id) return { status: 'failed', detail: `Couldn't read the status id from ${url}.` };
        const r = await postMastodon(ownSecrets.instance, ownSecrets.access_token, text, id);
        return { status: 'done', detail: `Replied on Mastodon: ${r.url}` };
      }
      if (action.channel === 'reddit') {
        const parent = redditParentFromUrl(url);
        if (!parent) return { status: 'failed', detail: `Couldn't read the Reddit post/comment id from ${url}.` };
        const r = await withRefresh(action.project_id, 'reddit', ownSecrets, def.label, (tok) => postRedditComment(tok, parent, text));
        return { status: 'done', detail: `Commented on Reddit${r.url ? `: ${r.url}` : ''}` };
      }
      return { status: 'ready', detail: `Auto-replies aren't supported on ${def.label} yet — open ${url} and reply manually.` };
    }

    if (action.channel === 'mastodon' && ownSecrets?.access_token && ownSecrets?.instance) {
      const r = await postMastodon(ownSecrets.instance, ownSecrets.access_token, text);
      return { status: 'done', detail: `Posted to Mastodon${ownSecrets.handle ? ` as @${ownSecrets.handle}` : ''}${r.count > 1 ? ` (${r.count}-post thread)` : ''}: ${r.url}` };
    }
    if (action.channel === 'x' && ownSecrets?.access_token) {
      const r = await withRefresh(action.project_id, 'x', ownSecrets, def.label, (tok) => postX(tok, text));
      return { status: 'done', detail: `Posted to X${ownSecrets.handle ? ` as @${ownSecrets.handle}` : ''}${r.count > 1 ? ` (${r.count}-tweet thread)` : ''}: ${r.url}` };
    }
    if (action.channel === 'reddit' && ownSecrets?.access_token) {
      const sub = subredditOf(action);
      if (!sub) return { status: 'ready', detail: 'Approved — add a target subreddit (e.g. r/IndieMusic) to this action, then it can auto-post.' };
      const r = await withRefresh(action.project_id, 'reddit', ownSecrets, def.label, (tok) => postReddit(tok, sub, action.title, action.content || ''));
      return { status: 'done', detail: `Posted to r/${sub}: ${r.url}` };
    }
    if (action.channel === 'linkedin' && ownSecrets?.access_token && ownSecrets?.author) {
      const r = await postLinkedin(ownSecrets.access_token, ownSecrets.author, text);
      return { status: 'done', detail: `Posted to LinkedIn${ownSecrets.handle ? ` as ${ownSecrets.handle}` : ''}${r.url ? `: ${r.url}` : ''}` };
    }
    // Paid ads (Meta / Google / Reddit): build a common spec + launch a real,
    // PAUSED campaign via the channel's provider, then activate it.
    if (isAdChannel(action.channel)) {
      const provider = adProvider(action.channel)!;
      let s = ownSecrets;
      if (!s?.access_token) {
        return { status: 'ready', detail: `Ad campaign prepared. Connect ${def.label} under ⚙ Channels (finish that platform's API approval, then pick your ad account) to launch it for real.` };
      }
      // Google: if the objective wasn't set explicitly, infer it from the product —
      // an app-store URL ⇒ App campaign (installs); otherwise a Search campaign.
      if (action.channel === 'google_ads' && !s.objective) {
        const det = parseAppStoreUrl(getProject(action.project_id)?.url || '');
        if (det) s = { ...s, objective: 'app', app_id: s.app_id || det.appId, app_store: s.app_store || det.store };
      }
      const m = safeJSON(action.meta) || {};
      const link = m.link || s.default_link || getProject(action.project_id)?.url || '';
      // Google App campaigns drive installs from the store listing — no website link needed.
      const isGoogleApp = action.channel === 'google_ads' && s.objective === 'app';
      if (!link && !isGoogleApp) return { status: 'ready', detail: 'Ad is ready but has no destination URL — add a link before launching.' };
      if (isGoogleApp && !s.app_id) {
        return { status: 'ready', detail: 'This is set to an App campaign but no app store ID is set — add it under ⚙ Channels → Google Ads (App installs), then approve.' };
      }
      // App Store URLs are a Meta-objective limitation specifically.
      if (action.channel === 'meta_ads' && /\b(apps\.apple\.com|itunes\.apple\.com|play\.google\.com)\b/i.test(link)) {
        return { status: 'ready', detail: 'This ad points to an App Store URL — Meta only allows those with the App Installs objective. Set a website "Default ad destination URL" under ⚙ Channels → Meta Ads (e.g. your landing page), then approve.' };
      }
      const spec: AdSpec = {
        name: action.title.slice(0, 80), objective: m.objective,
        dailyBudgetCents: action.cost_cents || 500,
        message: cleanCopy(action.content || action.summary, true), headline: m.headline || action.title.slice(0, 40),
        description: m.description || '', link,
        // Prefer the action's image, then the user's ad-image pool, then the Meta default.
        imageUrl: m.image_url || m.picture || adImageUrls(action.project_id)[0] || s.default_image_url, cta: m.cta || 'LEARN_MORE',
        headlines: m.headlines, descriptions: m.descriptions,
        countries: m.countries, ageMin: m.age_min, ageMax: m.age_max, interests: m.interests,
      };
      try {
        const ids = await provider.launch(s, spec);
        await provider.setStatus(s, ids, 'ACTIVE');
        return { status: 'done', detail: `Launched on ${def.label} at $${(spec.dailyBudgetCents / 100).toFixed(2)}/day (campaign ${ids.campaignId}).`, store: { meta_ids: ids } };
      } catch (e: any) {
        return { status: 'failed', detail: `${def.label} launch failed: ${String(e?.message || e)}` };
      }
    }
    if (emailish && smtp?.connected) return await sendEmail(smtp, action) as any;
    // A channel connected with its own posting webhook takes precedence.
    if (ownSecrets?.url) return await postWebhook(ownSecrets.url, action) as any;
    if (hook?.connected) { const h = safeJSON(hook.secrets); if (h?.url) return await postWebhook(h.url, action) as any; }
    return { status: 'ready', detail: 'Approved and publish-ready. Connect this channel or the automation webhook to auto-execute.' };
  } catch (e: any) {
    return { status: 'failed', detail: String(e?.message || e) };
  }
}
