import nodemailer from 'nodemailer';
import { getConnector, upsertConnector, type ActionRow, type Connector } from './db';
import { postMastodon, postX, refreshX, postReddit, refreshReddit } from './oauth';

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
  { key: 'webhook', label: 'Automation webhook (Zapier / Make / n8n / Buffer)', category: 'automation', executor: 'webhook', note: 'Universal bridge — approved actions are POSTed here so your automation publishes them anywhere.' },
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

  { key: 'meta_ads', label: 'Meta Ads', category: 'paid', executor: 'webhook', paid: true },
  { key: 'google_ads', label: 'Google Ads', category: 'paid', executor: 'webhook', paid: true },
  { key: 'reddit_ads', label: 'Reddit Ads', category: 'paid', executor: 'webhook', paid: true },
  { key: 'tiktok_ads', label: 'TikTok Ads', category: 'paid', executor: 'webhook', paid: true },
  { key: 'x_ads', label: 'X Ads', category: 'paid', executor: 'webhook', paid: true },
];

export const channelDef = (key: string): ChannelDef =>
  CHANNELS.find((c) => c.key === key) || { key, label: key, category: 'content', executor: 'manual' };

export function seedConnectors() {
  for (const ch of CHANNELS) {
    if (!getConnector(ch.key)) {
      upsertConnector({ key: ch.key, label: ch.label, executor: ch.executor, connected: false });
    }
  }
}

const OPT_OUT = '\n\n—\nYou received this because we think this is genuinely relevant to you. Reply "unsubscribe" and we will never contact you again.';

async function sendEmail(smtp: Connector, action: ActionRow): Promise<{ status: string; detail: string }> {
  const cfg = JSON.parse(smtp.secrets || '{}');
  const meta = action.meta ? JSON.parse(action.meta) : {};
  const to: string[] = ([] as string[]).concat(meta.to || meta.recipients || []).filter(Boolean);
  if (!to.length) {
    return { status: 'ready', detail: 'Approved, but no recipient was specified — email is ready to send once you add a recipient.' };
  }
  const transport = nodemailer.createTransport({
    host: cfg.host, port: Number(cfg.port) || 587,
    secure: cfg.secure ?? Number(cfg.port) === 465,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
  });
  const info = await transport.sendMail({
    from: cfg.from || cfg.user,
    to: to.join(', '),
    subject: meta.subject || action.title,
    text: (action.content || action.summary || '') + OPT_OUT,
  });
  return { status: 'done', detail: `Email sent to ${to.length} recipient(s) (id ${info.messageId}).` };
}

async function postWebhook(url: string, action: ActionRow): Promise<{ status: string; detail: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      channel: action.channel, kind: action.kind, title: action.title,
      summary: action.summary, content: action.content,
      meta: action.meta ? JSON.parse(action.meta) : null,
      cost_usd: action.cost_cents / 100,
    }),
  });
  if (!res.ok) throw new Error(`webhook responded ${res.status}`);
  return { status: 'done', detail: `Handed to automation webhook (HTTP ${res.status}). Your automation will publish it.` };
}

const safeJSON = (s: string | null) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

// Find the target subreddit for a Reddit action (meta, targeting, or content).
function subredditOf(action: ActionRow): string | null {
  const meta = safeJSON(action.meta) || {};
  if (meta.subreddit) return String(meta.subreddit).replace(/^\/?r\//i, '');
  const m = `${meta.targeting || ''} ${action.title} ${action.content || ''}`.match(/\br\/([A-Za-z0-9_]{2,30})\b/);
  return m ? m[1] : null;
}

// Run a post; on auth failure, refresh the token once, persist it, and retry.
async function withRefresh(channel: string, secrets: any, label: string, doPost: (token: string) => Promise<any>) {
  try {
    return await doPost(secrets.access_token);
  } catch (e) {
    if (!secrets.refresh_token) throw e;
    const t = channel === 'x'
      ? await refreshX(secrets.client_id, secrets.client_secret, secrets.refresh_token)
      : await refreshReddit(secrets.client_id, secrets.client_secret, secrets.refresh_token);
    const merged = { ...secrets, ...t };
    upsertConnector({ key: channel, label, executor: channel, connected: true, secrets: merged });
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
export async function runAction(action: ActionRow): Promise<{ status: 'done' | 'ready' | 'failed'; detail: string }> {
  // Account-setup tasks are always a human step — never auto-executed.
  if (action.kind === 'account') {
    const url = safeJSON(action.meta)?.signup_url;
    return { status: 'ready', detail: `Brand-account kit ready. Create the account${url ? ` at ${url}` : ' via the signup link below'}, then Connect it under ⚙ Channels.` };
  }
  const def = channelDef(action.channel);
  const emailish = def.executor === 'smtp' || ['email', 'outreach'].includes(action.kind);
  const own = getConnector(action.channel);
  const ownSecrets = own?.connected ? safeJSON(own.secrets) : null;
  const smtp = getConnector('smtp');
  const hook = getConnector('webhook');

  try {
    // Native API adapters: post directly via the platform (no webhook needed).
    const text = (action.content || action.summary || action.title || '').trim();
    if (action.channel === 'mastodon' && ownSecrets?.access_token && ownSecrets?.instance) {
      const r = await postMastodon(ownSecrets.instance, ownSecrets.access_token, text);
      return { status: 'done', detail: `Posted to Mastodon${ownSecrets.handle ? ` as @${ownSecrets.handle}` : ''}${r.count > 1 ? ` (${r.count}-post thread)` : ''}: ${r.url}` };
    }
    if (action.channel === 'x' && ownSecrets?.access_token) {
      const r = await withRefresh('x', ownSecrets, def.label, (tok) => postX(tok, text));
      return { status: 'done', detail: `Posted to X${ownSecrets.handle ? ` as @${ownSecrets.handle}` : ''}${r.count > 1 ? ` (${r.count}-tweet thread)` : ''}: ${r.url}` };
    }
    if (action.channel === 'reddit' && ownSecrets?.access_token) {
      const sub = subredditOf(action);
      if (!sub) return { status: 'ready', detail: 'Approved — add a target subreddit (e.g. r/IndieMusic) to this action, then it can auto-post.' };
      const r = await withRefresh('reddit', ownSecrets, def.label, (tok) => postReddit(tok, sub, action.title, action.content || ''));
      return { status: 'done', detail: `Posted to r/${sub}: ${r.url}` };
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
