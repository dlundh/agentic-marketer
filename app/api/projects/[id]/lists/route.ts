import { NextResponse } from 'next/server';
import {
  listEmailLists, createEmailList, deleteEmailList, addRecipients,
  addSuppressions, listSuppressions, listRecipients,
} from '@/lib/db';
import { emitEvent } from '@/lib/events';

export const runtime = 'nodejs';

const EMAIL_RE = /[^\s,;<>"]+@[^\s,;<>"]+\.[^\s,;<>"]+/;

// Parse pasted text or CSV into { email, name, company } rows. Handles an
// optional header row and comma / semicolon / tab delimiters.
function parseRecipients(text: string): { email: string; name?: string; company?: string }[] {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  let start = 0; let cols: string[] | null = null;
  const head = lines[0].split(/[,;\t]/).map((c) => c.trim().toLowerCase());
  if (head.some((c) => ['email', 'e-mail', 'email address'].includes(c))) { cols = head; start = 1; }
  const idx = (names: string[]) => (cols ? cols.findIndex((c) => names.includes(c)) : -1);
  const ie = idx(['email', 'e-mail', 'email address']);
  const inm = idx(['name', 'full name', 'full_name']);
  const ifn = idx(['first name', 'first_name', 'firstname']);
  const ic = idx(['company', 'organization', 'organisation', 'org']);
  const out: { email: string; name?: string; company?: string }[] = [];
  for (let i = start; i < lines.length; i++) {
    const cells = lines[i].split(/[,;\t]/).map((c) => c.trim().replace(/^["']|["']$/g, ''));
    let email: string | undefined, name: string | undefined, company: string | undefined;
    if (cols) {
      email = ie >= 0 ? cells[ie] : cells.find((c) => EMAIL_RE.test(c));
      name = inm >= 0 ? cells[inm] : (ifn >= 0 ? cells[ifn] : undefined);
      company = ic >= 0 ? cells[ic] : undefined;
    } else {
      email = cells.find((c) => EMAIL_RE.test(c));
      const rest = cells.filter((c) => c && c !== email);
      name = rest[0]; company = rest[1];
    }
    const m = email && email.match(EMAIL_RE);
    if (m) out.push({ email: m[0], name: name || undefined, company: company || undefined });
  }
  return out;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return NextResponse.json({ lists: listEmailLists(id), suppressions: listSuppressions(id) });
}

// Body: {action:'create',name,text} | {action:'add',list_id,text} |
//       {action:'delete',list_id} | {action:'suppress',text} | {action:'recipients',list_id}
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({} as any));
  const done = () => { emitEvent({ type: 'project', projectId: id }); };

  if (body.action === 'create') {
    const list = createEmailList(id, String(body.name || 'List'));
    const rows = parseRecipients(body.text || '');
    const added = addRecipients(list.id, id, rows);
    done();
    return NextResponse.json({ ok: true, list_id: list.id, added, parsed: rows.length });
  }
  if (body.action === 'add') {
    const rows = parseRecipients(body.text || '');
    const added = addRecipients(String(body.list_id), id, rows);
    done();
    return NextResponse.json({ ok: true, added, parsed: rows.length });
  }
  if (body.action === 'delete') {
    deleteEmailList(String(body.list_id)); done();
    return NextResponse.json({ ok: true });
  }
  if (body.action === 'suppress') {
    const emails = parseRecipients(body.text || '').map((r) => r.email);
    const n = addSuppressions(id, emails);
    done();
    return NextResponse.json({ ok: true, suppressed: n });
  }
  if (body.action === 'recipients') {
    return NextResponse.json({ recipients: listRecipients(String(body.list_id)) });
  }
  return NextResponse.json({ error: 'unknown action' }, { status: 400 });
}
