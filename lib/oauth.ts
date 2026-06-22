import { randomBytes, createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Native OAuth + posting for Mastodon, X/Twitter, and Reddit.
// Mastodon self-registers (no dev portal); X & Reddit need a one-time developer
// app (client id/secret) supplied by the user. All three then run a standard
// OAuth2 code flow and post directly via the platform API.
// ---------------------------------------------------------------------------

// Split text into word-bounded chunks for threading.
export function chunkText(text: string, limit: number): string[] {
  const clean = text.trim();
  if (clean.length <= limit) return [clean];
  const chunks: string[] = [];
  let cur = '';
  for (const w of clean.split(/\s+/)) {
    if ((cur + ' ' + w).trim().length > limit) { if (cur) chunks.push(cur.trim()); cur = w; }
    else cur = (cur + ' ' + w).trim();
  }
  if (cur) chunks.push(cur.trim());
  return chunks;
}

export function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// ---- X / Twitter (OAuth2 + PKCE) ------------------------------------------
const X_SCOPES = 'tweet.read tweet.write users.read offline.access';

export function xAuthorizeUrl(clientId: string, redirectUri: string, state: string, challenge: string): string {
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: X_SCOPES, state, code_challenge: challenge, code_challenge_method: 'S256' });
  // Use x.com (not twitter.com) — the user's login session is on x.com, so the
  // twitter.com authorize page wrongly reports "you have to be logged in".
  return `https://x.com/i/oauth2/authorize?${q.toString()}`;
}
function xAuthHeader(clientId: string, clientSecret?: string): Record<string, string> {
  return clientSecret ? { Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64') } : {};
}
export async function exchangeXCode(clientId: string, clientSecret: string, code: string, redirectUri: string, verifier: string) {
  const res = await fetch('https://api.twitter.com/2/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...xAuthHeader(clientId, clientSecret) },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier, client_id: clientId }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`X token exchange failed (HTTP ${res.status}): ${(await res.text()).slice(0, 140)}`);
  const j: any = await res.json();
  return { access_token: j.access_token, refresh_token: j.refresh_token };
}
export async function refreshX(clientId: string, clientSecret: string, refreshToken: string) {
  const res = await fetch('https://api.twitter.com/2/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...xAuthHeader(clientId, clientSecret) },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`X token refresh failed (HTTP ${res.status})`);
  const j: any = await res.json();
  return { access_token: j.access_token, refresh_token: j.refresh_token || refreshToken };
}
export async function verifyXAccount(token: string): Promise<{ handle: string; url: string }> {
  const res = await fetch('https://api.twitter.com/2/users/me', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`X verify failed (HTTP ${res.status})`);
  const j: any = await res.json();
  return { handle: j.data?.username, url: j.data?.username ? `https://x.com/${j.data.username}` : '' };
}
export async function postX(token: string, text: string): Promise<{ url: string; count: number }> {
  const chunks = chunkText(text, 270);
  let replyTo: string | undefined; let firstId = '';
  for (let i = 0; i < chunks.length; i++) {
    const payload: any = { text: chunks.length > 1 ? `${chunks[i]} (${i + 1}/${chunks.length})` : chunks[i] };
    if (replyTo) payload.reply = { in_reply_to_tweet_id: replyTo };
    const res = await fetch('https://api.twitter.com/2/tweets', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error(`X post failed (HTTP ${res.status}): ${(await res.text()).slice(0, 140)}`);
    const j: any = await res.json();
    if (i === 0) firstId = j.data?.id;
    replyTo = j.data?.id;
  }
  return { url: firstId ? `https://x.com/i/web/status/${firstId}` : '', count: chunks.length };
}

// ---- Reddit (OAuth2) -------------------------------------------------------
const REDDIT_SCOPES = 'identity submit read';
const REDDIT_UA = 'web:agentic-marketer:1.0 (marketing assistant)';

export function redditAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const q = new URLSearchParams({ client_id: clientId, response_type: 'code', state, redirect_uri: redirectUri, duration: 'permanent', scope: REDDIT_SCOPES });
  return `https://www.reddit.com/api/v1/authorize?${q.toString()}`;
}
function redditAuth(clientId: string, clientSecret: string) {
  return 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}
export async function exchangeRedditCode(clientId: string, clientSecret: string, code: string, redirectUri: string) {
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST', headers: { Authorization: redditAuth(clientId, clientSecret), 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': REDDIT_UA },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Reddit token exchange failed (HTTP ${res.status})`);
  const j: any = await res.json();
  return { access_token: j.access_token, refresh_token: j.refresh_token };
}
export async function refreshReddit(clientId: string, clientSecret: string, refreshToken: string) {
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST', headers: { Authorization: redditAuth(clientId, clientSecret), 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': REDDIT_UA },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Reddit token refresh failed (HTTP ${res.status})`);
  const j: any = await res.json();
  return { access_token: j.access_token, refresh_token: refreshToken };
}
export async function verifyRedditAccount(token: string): Promise<{ handle: string; url: string }> {
  const res = await fetch('https://oauth.reddit.com/api/v1/me', { headers: { Authorization: `Bearer ${token}`, 'User-Agent': REDDIT_UA }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Reddit verify failed (HTTP ${res.status})`);
  const j: any = await res.json();
  return { handle: j.name, url: `https://reddit.com/u/${j.name}` };
}
export async function postReddit(token: string, subreddit: string, title: string, text: string): Promise<{ url: string }> {
  const sr = subreddit.replace(/^\/?r\//i, '').replace(/^\/+/, '');
  const res = await fetch('https://oauth.reddit.com/api/submit', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': REDDIT_UA },
    body: new URLSearchParams({ sr, kind: 'self', title: title.slice(0, 300), text: text || '', api_type: 'json' }),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`Reddit submit failed (HTTP ${res.status}): ${(await res.text()).slice(0, 140)}`);
  const j: any = await res.json();
  const errs = j?.json?.errors;
  if (errs && errs.length) throw new Error(`Reddit: ${JSON.stringify(errs[0])}`);
  return { url: j?.json?.data?.url || '' };
}

// ---- Mastodon (self-registering) ------------------------------------------
const SCOPES = 'read write';

export function normalizeInstance(input: string): string {
  return String(input || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
}

// Dynamically register this app on the user's instance.
export async function registerMastodonApp(instance: string, redirectUri: string): Promise<{ client_id: string; client_secret: string }> {
  const res = await fetch(`https://${instance}/api/v1/apps`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Agentic Marketer', redirect_uris: redirectUri, scopes: SCOPES, website: redirectUri.replace(/\/api\/.*$/, '') }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Could not register on ${instance} (HTTP ${res.status}). Is that a real Mastodon instance?`);
  const j: any = await res.json();
  return { client_id: j.client_id, client_secret: j.client_secret };
}

export function authorizeUrl(instance: string, clientId: string, redirectUri: string, state: string): string {
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES, state });
  return `https://${instance}/oauth/authorize?${q.toString()}`;
}

export async function exchangeCode(instance: string, clientId: string, clientSecret: string, code: string, redirectUri: string): Promise<string> {
  const res = await fetch(`https://${instance}/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, scope: SCOPES }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Token exchange failed (HTTP ${res.status}).`);
  return (await res.json() as any).access_token;
}

export async function verifyAccount(instance: string, token: string): Promise<{ handle: string; url: string }> {
  const res = await fetch(`https://${instance}/api/v1/accounts/verify_credentials`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Could not verify account (HTTP ${res.status}).`);
  const j: any = await res.json();
  return { handle: j.acct || j.username, url: j.url };
}

async function postStatus(instance: string, token: string, status: string, inReplyTo?: string): Promise<{ id: string; url: string }> {
  const body = new URLSearchParams({ status });
  if (inReplyTo) body.set('in_reply_to_id', inReplyTo);
  const res = await fetch(`https://${instance}/api/v1/statuses`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body, signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`Post failed (HTTP ${res.status}): ${(await res.text()).slice(0, 140)}`);
  const j: any = await res.json();
  return { id: j.id, url: j.url };
}

// Post text, splitting into a reply-chain thread if it exceeds the per-post limit.
export async function postMastodon(instance: string, token: string, text: string): Promise<{ url: string; count: number }> {
  const LIMIT = 480;
  const clean = text.trim();
  let chunks: string[] = [];
  if (clean.length <= 500) {
    chunks = [clean];
  } else {
    let cur = '';
    for (const word of clean.split(/\s+/)) {
      if ((cur + ' ' + word).trim().length > LIMIT) { if (cur) chunks.push(cur.trim()); cur = word; }
      else cur = (cur + ' ' + word).trim();
    }
    if (cur) chunks.push(cur.trim());
  }
  let replyTo: string | undefined;
  let firstUrl = '';
  for (let i = 0; i < chunks.length; i++) {
    const status = chunks.length > 1 ? `${chunks[i]} (${i + 1}/${chunks.length})` : chunks[i];
    const r = await postStatus(instance, token, status, replyTo);
    if (i === 0) firstUrl = r.url;
    replyTo = r.id;
  }
  return { url: firstUrl, count: chunks.length };
}
