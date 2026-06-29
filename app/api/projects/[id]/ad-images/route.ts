import { NextResponse } from 'next/server';
import { addAdImage, listAdImages, deleteAdImage } from '@/lib/db';
import { emitEvent } from '@/lib/events';

export const runtime = 'nodejs';

// GET: list this project's ad creative images.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return NextResponse.json({ images: listAdImages(id) });
}

// POST { url, label? } — add an image URL to the pool.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const url = String(body.url || '').trim();
  if (!/^https?:\/\/.+/i.test(url)) return NextResponse.json({ error: 'Enter a valid public image URL (https://…).' }, { status: 400 });
  const img = addAdImage(id, url, body.label ? String(body.label) : undefined);
  emitEvent({ type: 'project', projectId: id });
  return NextResponse.json({ ok: true, image: img });
}

// DELETE ?img=<id>
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const imgId = new URL(req.url).searchParams.get('img') || '';
  if (imgId) { deleteAdImage(imgId); emitEvent({ type: 'project', projectId: id }); }
  return NextResponse.json({ ok: true });
}
