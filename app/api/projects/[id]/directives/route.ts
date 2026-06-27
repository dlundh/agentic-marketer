import { NextResponse } from 'next/server';
import { addDirective, listDirectives } from '@/lib/db';
import { emitEvent } from '@/lib/events';

export const runtime = 'nodejs';

// Add a piece of project-level direction that steers the whole marketing approach.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { text } = await req.json().catch(() => ({ text: '' }));
  const t = String(text || '').trim();
  if (!t) return NextResponse.json({ error: 'Empty direction.' }, { status: 400 });
  const d = addDirective(id, t);
  emitEvent({ type: 'project', projectId: id });
  return NextResponse.json({ ok: true, directive: d });
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return NextResponse.json({ directives: listDirectives(id) });
}
