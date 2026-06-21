import { NextResponse } from 'next/server';
import { query } from '@anthropic-ai/claude-agent-sdk';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Real probe: run a one-shot agent turn to confirm credentials actually work.
export async function POST() {
  try {
    let ok = false;
    let text = '';
    for await (const message of query({
      prompt: 'Reply with exactly: OK',
      options: { maxTurns: 1, allowedTools: [], permissionMode: 'bypassPermissions' },
    } as any)) {
      if ((message as any).type === 'result') {
        ok = (message as any).subtype === 'success';
        text = (message as any).result ?? '';
      }
    }
    return NextResponse.json({ ok, text });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 200 });
  }
}
