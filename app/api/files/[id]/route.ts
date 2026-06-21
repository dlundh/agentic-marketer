import { getFile } from '@/lib/db';
import { readFile } from 'node:fs/promises';

export const runtime = 'nodejs';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const file = getFile(id);
  if (!file) return new Response('not found', { status: 404 });
  let data: Buffer;
  try {
    data = await readFile(file.path);
  } catch {
    return new Response('file missing on disk', { status: 410 });
  }
  const inline = new URL(req.url).searchParams.get('inline') === '1';
  return new Response(new Uint8Array(data), {
    headers: {
      'Content-Type': file.mime,
      'Content-Length': String(data.length),
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${file.name.replace(/"/g, '')}"`,
    },
  });
}
