import { addSuppressions } from '@/lib/db';

export const runtime = 'nodejs';

// Public unsubscribe link target (works once the app is reachable on a real
// domain). Adds the address to the project's suppression set so it's never
// emailed again. Reply-based "unsubscribe" remains the local fallback.
export async function GET(req: Request) {
  const u = new URL(req.url);
  const p = u.searchParams.get('p') || '';
  const e = u.searchParams.get('e') || '';
  let ok = false;
  if (p && e) { try { addSuppressions(p, [e], 'unsubscribe-link'); ok = true; } catch {} }
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <body style="font-family:system-ui,sans-serif;background:#0b0b14;color:#e9e9f1;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0">
  <div style="text-align:center;max-width:420px;padding:24px">
    <h2>${ok ? 'You’ve been unsubscribed' : 'Unsubscribe'}</h2>
    <p style="color:#9a9ab0">${ok ? `${e} will no longer receive these emails.` : 'Sorry — we couldn’t process that link.'}</p>
  </div></body>`;
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
