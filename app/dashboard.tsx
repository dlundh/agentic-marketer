'use client';

import { ResponsiveContainer, LineChart, Line, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';

// ---- shared shapes (loosely typed; the API returns these) ------------------
type Perf = { spend_cents?: number; impressions?: number; clicks?: number; ctr?: number; conversions?: number; cpa_cents?: number };
type ActionItem = { id: string; channel: string; kind: string; title: string; status: string; scheduled_at?: number; cost_cents: number; meta: string | null; updated_at: number };
type Campaign = { budget_cents: number; spent_cents: number; daily_cap_cents: number; autonomy: string; auto_posts: number; status: string };
type DailyMetric = { day: string; spend_cents: number; installs: number; clicks: number; impressions: number };
export type Detail = { project: { id: string; title: string; phase: string }; campaign: Campaign | null; actions: ActionItem[]; metrics?: DailyMetric[]; jobs?: any[] };
export type ProjSummary = { id: string; title: string; phase: string; live?: boolean; campaign_status?: string | null; stats?: any };

const C = { accent: '#7c7cf0', green: '#3ddc97', amber: '#f5b14c', blue: '#6bb8f0', red: '#f06b6b', muted: '#8a8a9a', pink: '#e06bd0' };
const usd = (c: number) => `$${((c || 0) / 100).toFixed(2)}`;
const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
const parse = (m: string | null): any => { try { return m ? JSON.parse(m) : {}; } catch { return {}; } };
const chLabel = (k: string) => k.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());

function StatCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value" style={accent ? { color: accent } : undefined}>{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

const tooltipStyle = { background: '#12121a', border: '1px solid #2a2a3a', borderRadius: 8, fontSize: 12, color: '#e8e8f0' } as const;
function Panel({ title, children, hint }: { title: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="dash-panel">
      <div className="dash-panel-head">{title}{hint && <span className="dash-panel-hint">{hint}</span>}</div>
      {children}
    </div>
  );
}
const Empty = ({ msg }: { msg: string }) => <div className="dash-empty">{msg}</div>;

// ---- per-app dashboard -----------------------------------------------------
export function Dashboard({ detail }: { detail: Detail }) {
  const { campaign, actions, metrics = [] } = detail;
  const ads = actions.filter((a) => a.kind === 'ad');
  const liveAds = ads.filter((a) => a.status === 'done' && !parse(a.meta).ad_paused);
  const perfs = ads.map((a) => parse(a.meta).perf as Perf).filter(Boolean);
  const installs = perfs.reduce((s, p) => s + (p.conversions || 0), 0);
  const clicks = perfs.reduce((s, p) => s + (p.clicks || 0), 0);
  const impressions = perfs.reduce((s, p) => s + (p.impressions || 0), 0);
  const adSpend = perfs.reduce((s, p) => s + (p.spend_cents || 0), 0);
  const ctr = impressions ? clicks / impressions : 0;
  const cpc = clicks ? adSpend / clicks : 0;
  const cpa = installs ? adSpend / installs : 0;
  const published = actions.filter((a) => a.kind !== 'ad' && ['done', 'sent'].includes(a.status));
  const scheduled = actions.filter((a) => a.status === 'scheduled');
  const proposed = actions.filter((a) => ['proposed', 'revising'].includes(a.status));

  // spend by channel (from ad perf)
  const byChannel: Record<string, number> = {};
  for (const a of ads) { const p = parse(a.meta).perf as Perf; if (p?.spend_cents) byChannel[a.channel] = (byChannel[a.channel] || 0) + p.spend_cents; }
  const spendData = Object.entries(byChannel).map(([k, v]) => ({ name: chLabel(k), spend: +(v / 100).toFixed(2) }));

  // posts published by channel
  const postCh: Record<string, number> = {};
  for (const a of published) postCh[a.channel] = (postCh[a.channel] || 0) + 1;
  const postData = Object.entries(postCh).map(([k, v]) => ({ name: chLabel(k), posts: v }));

  // actions by status
  const statusColors: Record<string, string> = { done: C.green, sent: C.green, scheduled: C.blue, proposed: C.amber, ready: C.accent, failed: C.red, rejected: C.muted, approved: C.blue };
  const statusCount: Record<string, number> = {};
  for (const a of actions) statusCount[a.status] = (statusCount[a.status] || 0) + 1;
  const statusData = Object.entries(statusCount).map(([k, v]) => ({ name: k, value: v }));

  // per-ad CTR (live + recently run)
  const adCtr = ads.filter((a) => parse(a.meta).perf?.impressions).map((a) => {
    const p = parse(a.meta).perf as Perf; return { name: a.title.slice(0, 22), ctr: +((p.clicks! / p.impressions!) * 100).toFixed(2), installs: p.conversions || 0 };
  }).sort((x, y) => y.ctr - x.ctr).slice(0, 8);

  // trend series
  const trend = metrics.map((m) => ({ day: m.day.slice(5), spend: +(m.spend_cents / 100).toFixed(2), installs: +(+m.installs).toFixed(1) }));

  return (
    <div className="dash">
      <div className="kpi-row">
        <StatCard label="Ad spend" value={usd(campaign?.spent_cents || 0)} sub={campaign ? `of ${usd(campaign.budget_cents)} cap` : 'no campaign'} accent={C.green} />
        <StatCard label="Remaining" value={usd((campaign?.budget_cents || 0) - (campaign?.spent_cents || 0))} sub={campaign?.daily_cap_cents ? `${usd(campaign.daily_cap_cents)}/day cap` : 'no daily cap'} />
        <StatCard label="Installs / conv." value={String(Math.round(installs))} sub={cpa ? `${usd(cpa)} CPA` : 'no conversions yet'} accent={C.pink} />
        <StatCard label="Live ads" value={String(liveAds.length)} sub={`${ads.length} total`} accent={C.blue} />
        <StatCard label="Avg CTR" value={impressions ? pct(ctr) : '—'} sub={clicks ? `${clicks.toLocaleString()} clicks` : 'no clicks yet'} />
        <StatCard label="Avg CPC" value={cpc ? usd(cpc) : '—'} sub={impressions ? `${impressions.toLocaleString()} impressions` : ''} />
        <StatCard label="Posts published" value={String(published.length)} sub={`${scheduled.length} scheduled`} accent={C.accent} />
        <StatCard label="Needs approval" value={String(proposed.length)} sub="awaiting you" accent={proposed.length ? C.amber : undefined} />
      </div>

      <div className="dash-grid">
        <Panel title="Spend & installs over time" hint="daily">
          {trend.length > 1 ? (
            <ResponsiveContainer width="100%" height={230}>
              <LineChart data={trend} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                <CartesianGrid stroke="#22222e" vertical={false} />
                <XAxis dataKey="day" stroke={C.muted} fontSize={11} tickLine={false} />
                <YAxis yAxisId="l" stroke={C.green} fontSize={11} tickLine={false} width={38} />
                <YAxis yAxisId="r" orientation="right" stroke={C.pink} fontSize={11} tickLine={false} width={28} />
                <Tooltip contentStyle={tooltipStyle} />
                <Line yAxisId="l" type="monotone" dataKey="spend" name="Spend $" stroke={C.green} strokeWidth={2} dot={false} />
                <Line yAxisId="r" type="monotone" dataKey="installs" name="Installs" stroke={C.pink} strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          ) : <Empty msg="Trend builds up as ad-spend is synced each day. Check back after ads run." />}
        </Panel>

        <Panel title="Ad spend by channel">
          {spendData.length ? (
            <ResponsiveContainer width="100%" height={230}>
              <BarChart data={spendData} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                <CartesianGrid stroke="#22222e" vertical={false} />
                <XAxis dataKey="name" stroke={C.muted} fontSize={11} tickLine={false} />
                <YAxis stroke={C.muted} fontSize={11} tickLine={false} width={38} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: '#ffffff08' }} />
                <Bar dataKey="spend" name="Spend $" fill={C.green} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <Empty msg="No ad spend recorded yet." />}
        </Panel>

        <Panel title="Ad CTR (top performers)">
          {adCtr.length ? (
            <ResponsiveContainer width="100%" height={230}>
              <BarChart data={adCtr} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
                <CartesianGrid stroke="#22222e" horizontal={false} />
                <XAxis type="number" stroke={C.muted} fontSize={11} tickLine={false} unit="%" />
                <YAxis type="category" dataKey="name" stroke={C.muted} fontSize={10} tickLine={false} width={130} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: '#ffffff08' }} />
                <Bar dataKey="ctr" name="CTR %" fill={C.blue} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <Empty msg="No ad performance yet — launch an ad and it'll appear here." />}
        </Panel>

        <Panel title="Action pipeline">
          {statusData.length ? (
            <ResponsiveContainer width="100%" height={230}>
              <PieChart>
                <Pie data={statusData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={52} outerRadius={82} paddingAngle={2}>
                  {statusData.map((s) => <Cell key={s.name} fill={statusColors[s.name] || C.muted} />)}
                </Pie>
                <Tooltip contentStyle={tooltipStyle} />
              </PieChart>
            </ResponsiveContainer>
          ) : <Empty msg="No actions yet." />}
          <div className="dash-legend">{statusData.map((s) => <span key={s.name}><i style={{ background: statusColors[s.name] || C.muted }} />{s.name} {s.value}</span>)}</div>
        </Panel>

        <Panel title="Posts published by channel">
          {postData.length ? (
            <ResponsiveContainer width="100%" height={230}>
              <BarChart data={postData} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                <CartesianGrid stroke="#22222e" vertical={false} />
                <XAxis dataKey="name" stroke={C.muted} fontSize={11} tickLine={false} />
                <YAxis stroke={C.muted} fontSize={11} tickLine={false} width={28} allowDecimals={false} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: '#ffffff08' }} />
                <Bar dataKey="posts" name="Posts" fill={C.accent} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <Empty msg="No posts published yet." />}
        </Panel>
      </div>
    </div>
  );
}

// ---- god view: all apps ----------------------------------------------------
export function GodView({ projects, onOpen }: { projects: ProjSummary[]; onOpen: (id: string) => void }) {
  const withStats = projects.map((p) => ({ p, s: p.stats || {} }));
  const totSpend = withStats.reduce((n, { s }) => n + (s.spent_cents || 0), 0);
  const totInstalls = withStats.reduce((n, { s }) => n + (s.installs || 0), 0);
  const totLive = withStats.reduce((n, { s }) => n + (s.live_ads || 0), 0);
  const totPublished = withStats.reduce((n, { s }) => n + (s.published || 0), 0);
  return (
    <div className="dash">
      <div className="kpi-row">
        <StatCard label="Apps" value={String(projects.length)} sub="marketed" accent={C.accent} />
        <StatCard label="Total ad spend" value={usd(totSpend)} accent={C.green} />
        <StatCard label="Total installs/conv." value={String(Math.round(totInstalls))} accent={C.pink} />
        <StatCard label="Live ads" value={String(totLive)} accent={C.blue} />
        <StatCard label="Posts published" value={String(totPublished)} />
      </div>
      <div className="godgrid">
        {withStats.map(({ p, s }) => (
          <button key={p.id} className="godcard" onClick={() => onOpen(p.id)}>
            <div className="godcard-top">
              <span className="godcard-title">{p.title}</span>
              <span className={`phasechip phase-${p.phase}`}>{p.phase}</span>
            </div>
            {s.has_campaign ? (
              <>
                <div className="godcard-stats">
                  <span><b>{usd(s.spent_cents)}</b> spent</span>
                  <span><b>{Math.round(s.installs || 0)}</b> installs</span>
                  <span><b>{s.live_ads || 0}</b> live ads</span>
                  <span><b>{s.published || 0}</b> posts</span>
                </div>
                <div className="godcard-meter"><div style={{ width: `${s.budget_cents ? Math.min(100, (s.spent_cents / s.budget_cents) * 100) : 0}%` }} /></div>
                <div className="godcard-foot">
                  {s.status === 'paused' ? <span className="paused-tag">paused</span> : p.live ? <span className="auto-working"><span className="spin">⟳</span> active</span> : <span>{usd(s.remaining_cents)} left</span>}
                  {s.proposed > 0 && <span className="godcard-badge">{s.proposed} to approve</span>}
                </div>
              </>
            ) : <div className="godcard-stats"><span>No campaign yet — {p.phase}</span></div>}
          </button>
        ))}
      </div>
    </div>
  );
}
