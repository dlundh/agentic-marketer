import { changeSignature } from '@/lib/db';
import { reconcile } from '@/lib/orchestrator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60 * 30;

// Server-Sent Events driven by polling the DB change-signature. This is the one
// source of truth shared by every connection, so the browser gets live updates
// regardless of which Next bundle owns the running agents / event bus.
export async function GET() {
  reconcile();
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      let last = '';
      const send = (obj: any) => {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)); }
        catch { if (timer) clearInterval(timer); }
      };
      send({ type: 'hello' });
      timer = setInterval(() => {
        let sig = '';
        try { sig = changeSignature(); } catch { return; }
        if (sig !== last) { last = sig; send({ type: 'changed' }); }
        else { try { controller.enqueue(encoder.encode(': ping\n\n')); } catch { if (timer) clearInterval(timer); } }
      }, 1000);
    },
    cancel() { if (timer) clearInterval(timer); },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
