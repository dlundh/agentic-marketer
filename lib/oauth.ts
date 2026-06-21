// ---------------------------------------------------------------------------
// Mastodon native integration. Mastodon is unique: a client can REGISTER ITSELF
// on any instance via POST /api/v1/apps (no developer portal), then run a normal
// OAuth2 code flow, then post via the API. So the app genuinely "creates the
// trigger and uses it" — no Zapier, no manual setup.
// ---------------------------------------------------------------------------

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
