import nodemailer from 'nodemailer';
import { getConnector, upsertConnector, type ActionRow, type Connector } from './db';

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
    if (emailish && smtp?.connected) return await sendEmail(smtp, action) as any;
    // A channel connected with its own posting webhook takes precedence.
    if (ownSecrets?.url) return await postWebhook(ownSecrets.url, action) as any;
    if (hook?.connected) { const h = safeJSON(hook.secrets); if (h?.url) return await postWebhook(h.url, action) as any; }
    return { status: 'ready', detail: 'Approved and publish-ready. Connect this channel or the automation webhook to auto-execute.' };
  } catch (e: any) {
    return { status: 'failed', detail: String(e?.message || e) };
  }
}
