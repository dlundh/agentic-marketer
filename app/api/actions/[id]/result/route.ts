import { NextResponse } from 'next/server';
import { getAction, updateAction } from '@/lib/db';
import { emitEvent } from '@/lib/events';

export const runtime = 'nodejs';

// Callback target for webhook-published actions: your Zap/Make scenario POSTs the
// real outcome here so the app can confirm "live" (with a link) or "failed".
// Accepts flexible shapes, e.g.:
//   { "ok": true, "url": "https://www.linkedin.com/feed/update/urn:li:share:123" }
//   { "ok": false, "error": "Commentary is required" }
// (also tolerates success/status/link/permalink/message field names)
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const a = getAction(id);
  if (!a) return NextResponse.json({ error: 'unknown action' }, { status: 404 });

  const body = await req.json().catch(() => ({} as any));
  const url = body.url || body.link || body.permalink || body.post_url || '';
  const error = body.error || body.message || '';
  const okField = body.ok ?? body.success ??
    (typeof body.status === 'string' ? ['done', 'success', 'ok', 'live', 'posted'].includes(String(body.status).toLowerCase()) : undefined);
  const failed = okField === false || (!!error && okField !== true);

  const meta = a.meta ? JSON.parse(a.meta) : {};
  if (url) meta.live_url = url;

  if (failed) {
    updateAction(id, { status: 'failed', result: `Publish failed (reported by your automation): ${error || 'unknown error'}`, meta: JSON.stringify(meta) });
  } else {
    updateAction(id, { status: 'done', result: url ? `Published — confirmed live: ${url}` : 'Published — confirmed by your automation.', meta: JSON.stringify(meta) });
  }
  emitEvent({ type: 'finding', projectId: a.project_id });
  return NextResponse.json({ ok: true });
}
