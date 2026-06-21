import { NextResponse } from 'next/server';
import { detectAuth, applyToken } from '@/lib/auth';

export const runtime = 'nodejs';

export async function GET() {
  return NextResponse.json(detectAuth());
}

export async function POST(req: Request) {
  const { token } = await req.json().catch(() => ({ token: '' }));
  if (token) applyToken(String(token));
  return NextResponse.json(detectAuth());
}
