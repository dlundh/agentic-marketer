'use client';

import { useCallback, useEffect, useState } from 'react';

type ActionItem = { id: string; channel: string; kind: string; title: string; content: string | null; cost_cents: number; status: string; meta: string | null; auto?: boolean };
const parse = (m: string | null): any => { try { return m ? JSON.parse(m) : {}; } catch { return {}; } };
// Mirror the server-side cleanCopy so previews match the live creative (strip
// stray scaffolding labels the model sometimes left in older stored copy).
const BODY_LABEL = /^\s*(?:[-*•]\s*)?(primary text|body copy|body|caption|ad copy|copy|post|message|hook|headline)\s*:\s+/i;
const META_LINE = /^\s*(?:[-*•>]\s*)?(final url|destination url|display path|landing page|cta|call[- ]to[- ]action|headlines?|descriptions?|primary text|character (?:count|limit)|image|format)\s*[:(]/i;
const cleanBody = (t: string) => t.split('\n').filter((l) => !META_LINE.test(l)).map((l) => l.replace(BODY_LABEL, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
const usd = (c: number) => `$${((c || 0) / 100).toFixed(2)}`;
const CH: Record<string, string> = { meta_ads: 'Meta', google_ads: 'Google', reddit_ads: 'Reddit', tiktok_ads: 'TikTok', x_ads: 'X' };
const domainOf = (url?: string) => { if (!url) return ''; try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url.replace(/^https?:\/\//, '').split('/')[0]; } };

// Resolve the creative fields the way the launcher does, so previews match reality.
function creative(a: ActionItem, poolImg?: string) {
  const m = parse(a.meta);
  const headlines: string[] = Array.isArray(m.headlines) ? m.headlines.filter(Boolean) : [];
  const descriptions: string[] = Array.isArray(m.descriptions) ? m.descriptions.filter(Boolean) : (m.description ? [m.description] : []);
  const headline = m.headline || headlines[0] || a.title;
  const image = m.image_url || m.picture || poolImg || '';
  const isApp = /app/i.test(m.objective || '') || /App Install|App Promotion|App Campaign/i.test(a.title);
  const cta = m.cta ? String(m.cta).replace(/_/g, ' ').replace(/\b\w/g, (x) => x.toUpperCase()) : (isApp ? 'Install' : 'Learn More');
  const link = m.link || m.app_store_url || '';
  // Google search ads are text-only (headlines/descriptions, no image).
  const isGoogleSearch = a.channel === 'google_ads' && !image && (headlines.length > 0 || !isApp);
  return { m, headline, headlines, descriptions, image, cta, link, isApp, isGoogleSearch, perf: m.perf, paused: !!m.ad_paused };
}

function Perf({ perf, cost, status }: { perf: any; cost: number; status: string }) {
  return (
    <div className="adp-perf">
      <span>{usd(cost)}<i>/day</i></span>
      {perf ? (<>
        {perf.conversions >= 1 && <span className="adp-win">✓ {perf.conversions} inst</span>}
        <span>{perf.impressions?.toLocaleString() || 0} impr</span>
        <span>{perf.clicks || 0} clicks</span>
        <span>{perf.impressions ? ((perf.clicks / perf.impressions) * 100).toFixed(2) : '0.00'}% CTR</span>
        <span>{usd(perf.spend_cents || 0)} spent</span>
      </>) : <span className="adp-nostat">{status === 'proposed' ? 'not launched yet' : 'no data yet'}</span>}
    </div>
  );
}

function Controls({ a, onAdControl, onDecide }: { a: ActionItem; onAdControl: (id: string, x: 'pause_ad' | 'resume_ad' | 'remove_ad') => void; onDecide: (id: string, x: 'approve' | 'reject') => void }) {
  const c = creative(a);
  if (a.status === 'done') return (
    <div className="adp-ctrls">
      {c.paused ? <button className="mini" onClick={() => onAdControl(a.id, 'resume_ad')}>▶ Resume</button>
        : <button className="mini" onClick={() => onAdControl(a.id, 'pause_ad')}>⏸ Pause</button>}
      <button className="mini danger" onClick={() => onAdControl(a.id, 'remove_ad')}>🗑 Remove</button>
    </div>
  );
  if (a.status === 'proposed' || a.status === 'failed' || a.status === 'ready') return (
    <div className="adp-ctrls">
      <button className="mini approve-mini" disabled={!a.auto} onClick={() => onDecide(a.id, 'approve')}>{a.status === 'proposed' ? `✓ Approve (${usd(a.cost_cents)})` : '↻ Retry'}</button>
      <button className="mini" onClick={() => onDecide(a.id, 'reject')}>✕ Reject</button>
    </div>
  );
  return null;
}

function AdPreview({ a, advertiser, poolImg, onAdControl, onDecide }: { a: ActionItem; advertiser: string; poolImg?: string; onAdControl: any; onDecide: any }) {
  const c = creative(a, poolImg);
  const body = cleanBody(a.content || '');
  const statusChip = a.status === 'done' ? (c.paused ? <span className="adp-chip paused">⏸ Paused</span> : <span className="adp-chip live">● Live</span>)
    : a.status === 'proposed' ? <span className="adp-chip prop">Proposed</span>
    : a.status === 'failed' ? <span className="adp-chip fail">Failed</span>
    : a.status === 'ready' ? <span className="adp-chip ready">Ready</span> : null;

  return (
    <div className="adp">
      <div className="adp-head"><span className="adp-net">{CH[a.channel] || a.channel}</span>{c.m.angle && <span className="adp-angle">🎯 {c.m.angle}</span>}{statusChip}</div>

      {c.isGoogleSearch ? (
        <div className="adp-google">
          <div className="gad-row"><span className="gad-ad">Ad</span><span className="gad-url">{domainOf(c.link) || 'your-site.com'}</span></div>
          <div className="gad-title">{(c.headlines.length ? c.headlines : [c.headline]).slice(0, 3).join(' · ')}</div>
          <div className="gad-desc">{(c.descriptions.length ? c.descriptions : [body]).join(' ').slice(0, 180)}</div>
        </div>
      ) : (
        <div className="adp-meta">
          <div className="adp-brandrow">
            <div className="adp-avatar">{advertiser.slice(0, 1).toUpperCase()}</div>
            <div><div className="adp-brand">{advertiser}</div><div className="adp-spon">Sponsored</div></div>
          </div>
          {body && <div className="adp-primary">{body.length > 220 ? body.slice(0, 220) + '…' : body}</div>}
          <div className="adp-creative">
            {c.image ? <img src={c.image} alt="" loading="lazy" onError={(e) => { (e.currentTarget.parentElement as HTMLElement).classList.add('noimg'); }} /> : <div className="adp-noimg">no image set — add one under 🖼 Ad images</div>}
          </div>
          <div className="adp-cap">
            <div className="adp-capmeta">
              <div className="adp-caphead">{c.headline}</div>
              {(c.descriptions[0]) && <div className="adp-capdesc">{c.descriptions[0]}</div>}
            </div>
            <button className="adp-ctabtn">{c.cta}</button>
          </div>
        </div>
      )}

      <Perf perf={c.perf} cost={a.cost_cents} status={a.status} />
      <Controls a={a} onAdControl={onAdControl} onDecide={onDecide} />
    </div>
  );
}

export function AdsView({ projectId, actions, advertiser, onAdControl, onDecide }: {
  projectId: string; actions: ActionItem[]; advertiser: string;
  onAdControl: (id: string, x: 'pause_ad' | 'resume_ad' | 'remove_ad') => void; onDecide: (id: string, x: 'approve' | 'reject') => void;
}) {
  const [pool, setPool] = useState<string[]>([]);
  const load = useCallback(async () => {
    try { const d = await (await fetch(`/api/projects/${projectId}/ad-images`)).json(); setPool((d.images || []).map((i: any) => i.url)); } catch {}
  }, [projectId]);
  useEffect(() => { load(); }, [load]);

  const ads = actions.filter((a) => a.kind === 'ad');
  const live = ads.filter((a) => a.status === 'done' && !parse(a.meta).ad_paused);
  const paused = ads.filter((a) => a.status === 'done' && parse(a.meta).ad_paused);
  const pending = ads.filter((a) => ['proposed', 'ready', 'failed'].includes(a.status));
  const poolImg = pool[0];

  const Group = ({ title, list, accent }: { title: string; list: ActionItem[]; accent?: string }) => (
    <div className="adp-group">
      <div className="adp-grouphead" style={accent ? { color: accent } : undefined}>{title} · {list.length}</div>
      <div className="adp-grid">{list.map((a) => <AdPreview key={a.id} a={a} advertiser={advertiser} poolImg={poolImg} onAdControl={onAdControl} onDecide={onDecide} />)}</div>
    </div>
  );

  if (!ads.length) return <div className="empty" style={{ marginTop: 24 }}>No ads yet. Connect a paid channel and generate/launch an ad — they'll appear here as live previews.</div>;
  return (
    <div className="ads-view">
      {live.length > 0 && <Group title="🟢 Live" list={live} accent="var(--green)" />}
      {pending.length > 0 && <Group title="🟡 Pending / needs action" list={pending} accent="var(--amber)" />}
      {paused.length > 0 && <Group title="⏸ Paused" list={paused} accent="var(--muted)" />}
    </div>
  );
}
