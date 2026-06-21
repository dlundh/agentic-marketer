'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// ----------------------------- types ---------------------------------------
type Job = {
  id: string; project_id: string; kind: string; title: string; status: string;
  phase: string | null; summary: string | null; error: string | null;
  created_at: number; updated_at: number; live?: boolean; activity?: Activity[];
};
type Activity = { id: string; kind: string; label: string | null; content: string | null; created_at: number };
type Finding = { id: string; category: string | null; title: string; summary: string | null; details: string | null; job_id: string | null };
type FileRow = { id: string; name: string; mime: string; size: number; kind: string | null; job_id: string | null };
type Project = { id: string; title: string; prompt: string; url: string | null; phase: string; status: string; summary: string | null; updated_at: number; jobs?: Job[] };
type Campaign = { id: string; status: string; currency: string; budget_cents: number; spent_cents: number; channels: string | null; autonomy: string; strategy: string | null };
type ActionItem = { id: string; channel: string; kind: string; title: string; summary: string | null; content: string | null; meta: string | null; cost_cents: number; status: string; result: string | null; job_id: string | null };
type Detail = { project: Project; jobs: Job[]; findings: Finding[]; files: FileRow[]; campaign: Campaign | null; actions: ActionItem[] };
type Auth = { connected: boolean; method: string; detail: string };
type Channel = { key: string; label: string; category: string; executor: string; paid: boolean; note?: string; connected: boolean };

// ----------------------------- helpers --------------------------------------
const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const ago = (t: number) => {
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(t).toLocaleDateString();
};

// =============================================================================
export default function Page() {
  const [auth, setAuth] = useState<Auth | null>(null);
  const [showConnect, setShowConnect] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [modalJobId, setModalJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showChannels, setShowChannels] = useState(false);
  const [showLaunch, setShowLaunch] = useState(false);

  // ---- data loaders ----
  const loadAuth = useCallback(async () => {
    try { setAuth(await (await fetch('/api/auth/status')).json()); } catch {}
  }, []);
  const loadProjects = useCallback(async () => {
    try {
      const d = await (await fetch('/api/projects')).json();
      setProjects(d.projects || []);
      return d.projects as Project[];
    } catch { return []; }
  }, []);
  const loadDetail = useCallback(async (id: string) => {
    try { setDetail(await (await fetch(`/api/projects/${id}`)).json()); } catch {}
  }, []);

  // initial load: pick the most recent active project as the current view
  useEffect(() => {
    loadAuth();
    loadProjects().then((ps) => {
      const active = ps.find((p) => p.status === 'active') || ps[0];
      if (active) setCurrentId(active.id);
    });
  }, [loadAuth, loadProjects]);

  useEffect(() => { if (currentId) loadDetail(currentId); }, [currentId, loadDetail]);

  // ---- SSE live updates ----
  const currentRef = useRef<string | null>(null);
  currentRef.current = currentId;
  useEffect(() => {
    const es = new EventSource('/api/stream');
    let t: any;
    const refresh = () => { clearTimeout(t); t = setTimeout(() => {
      loadProjects();
      if (currentRef.current) loadDetail(currentRef.current);
    }, 250); };
    es.onmessage = (e) => {
      try { const ev = JSON.parse(e.data); if (ev.type !== 'hello') refresh(); } catch {}
    };
    es.onerror = () => {/* browser auto-reconnects */};
    return () => { es.close(); clearTimeout(t); };
  }, [loadProjects, loadDetail]);

  // ---- submit ----
  const onSubmit = async (fd: FormData) => {
    setError(null);
    const res = await fetch('/api/projects', { method: 'POST', body: fd });
    const d = await res.json();
    if (!res.ok) { setError(d.error || 'Failed to start.'); return; }
    await loadProjects();
    setCurrentId(d.project.id);
    if (!auth?.connected) setShowConnect(true);
  };

  const control = async (jobId: string, action: 'pause' | 'resume') => {
    await fetch(`/api/jobs/${jobId}/${action}`, { method: 'POST' });
    if (currentId) loadDetail(currentId);
    loadProjects();
  };

  const launchCampaign = async (budgetUsd: number, channels: string[]) => {
    if (!currentId) return;
    const res = await fetch(`/api/projects/${currentId}/campaign`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ budget_usd: budgetUsd, channels, autonomy: 'approval' }),
    });
    const d = await res.json();
    if (!res.ok) { setError(d.error || 'Failed to launch.'); return; }
    setShowLaunch(false);
    loadDetail(currentId);
  };

  const decide = async (actionId: string, action: 'approve' | 'reject') => {
    const res = await fetch(`/api/actions/${actionId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok && d.error) setError(d.error);
    if (currentId) loadDetail(currentId);
  };

  const revise = async (actionId: string, feedback: string) => {
    const res = await fetch(`/api/actions/${actionId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'revise', feedback }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok && d.error) setError(d.error);
    if (currentId) loadDetail(currentId);
  };

  const optimize = async () => {
    if (!currentId) return;
    await fetch(`/api/projects/${currentId}/campaign`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'optimize' }),
    });
    loadDetail(currentId);
  };

  const createAccount = async (channel: string): Promise<string | null> => {
    if (!currentId) return 'Open a project first.';
    const res = await fetch(`/api/projects/${currentId}/account`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel }),
    });
    const d = await res.json().catch(() => ({}));
    loadDetail(currentId);
    return res.ok ? null : (d.error || 'Failed.');
  };

  const modalJob = detail?.jobs.find((j) => j.id === modalJobId) || null;

  return (
    <>
      <div className="topbar">
        <div className="brand"><span className="dot" /> Agentic Marketer</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button className="connect" onClick={() => setShowChannels(true)}>⚙ Channels</button>
          <button className={`connect ${auth?.connected ? 'on' : 'off'}`} onClick={() => setShowConnect(true)}>
            <span className="pip" />
            {auth?.connected ? 'Claude connected' : 'Connect Claude'}
          </button>
        </div>
      </div>

      <div className="wrap">
        <Hero onSubmit={onSubmit} />
        {error && <div className="banner" style={{ marginTop: 20 }}>{error}</div>}

        {/* ACTIVE PROJECT */}
        {detail && (
          <div className="section">
            <h2>
              Active · {detail.project.title}
              {' '}<PhaseChip phase={detail.project.phase} />
            </h2>
            <div className="jobs">
              {detail.jobs.map((j) => (
                <JobCard
                  key={j.id}
                  job={j}
                  onOpen={() => setModalJobId(j.id)}
                  onControl={control}
                />
              ))}
              {detail.jobs.length === 0 && <div className="empty">No jobs yet.</div>}
            </div>

            {/* Execution phase: campaign + action queue, or a CTA to launch it */}
            {detail.campaign ? (
              <CampaignPanel
                campaign={detail.campaign}
                actions={detail.actions}
                onDecide={decide}
                onRevise={revise}
                onOptimize={optimize}
                anyExecLive={detail.jobs.some((j) => j.phase === 'execution' && j.live)}
              />
            ) : ['marketing', 'done'].includes(detail.project.phase) && !detail.jobs.some((j) => j.live) ? (
              <div className="launch-cta">
                <div>
                  <div className="lc-title">🚀 Ready to execute</div>
                  <div className="note">Research and the marketing plan are done. Launch the growth swarm to start proposing real actions to reach customers — within a budget you set (even $0).</div>
                </div>
                <button className="submit" onClick={() => setShowLaunch(true)}>Launch growth campaign →</button>
              </div>
            ) : null}
          </div>
        )}

        {/* HISTORY */}
        <div className="section">
          <h2>History</h2>
          {projects.length === 0 ? (
            <div className="empty">Nothing yet. Describe a product above to dispatch your first research agents.</div>
          ) : (
            <div className="hist">
              {projects.map((p) => (
                <div key={p.id} className="hist-card" onClick={() => setCurrentId(p.id)}>
                  <div className="t">{p.title}</div>
                  <div className="d">{p.summary || p.prompt}</div>
                  <div className="foot">
                    <PhaseChip phase={p.phase} />
                    <span>{(p.jobs?.length || 0)} job{(p.jobs?.length || 0) === 1 ? '' : 's'} · {ago(p.updated_at)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {modalJob && detail && (
        <JobModal
          job={modalJob}
          findings={detail.findings.filter((f) => f.job_id === modalJob.id)}
          files={detail.files.filter((f) => f.job_id === modalJob.id)}
          onClose={() => setModalJobId(null)}
        />
      )}
      {showConnect && <ConnectModal auth={auth} onClose={() => setShowConnect(false)} reload={loadAuth} />}
      {showChannels && <ChannelsModal onClose={() => setShowChannels(false)} hasCampaign={!!detail?.campaign} hasProject={!!currentId} onCreate={createAccount} />}
      {showLaunch && detail && <LaunchModal onClose={() => setShowLaunch(false)} onLaunch={launchCampaign} />}
    </>
  );
}

// ----------------------------- Hero / search --------------------------------
function Hero({ onSubmit }: { onSubmit: (fd: FormData) => void }) {
  const [prompt, setPrompt] = useState('');
  const [url, setUrl] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const submit = async () => {
    if (busy) return;
    if (!prompt.trim() && !url.trim()) return;
    setBusy(true);
    const fd = new FormData();
    fd.set('prompt', prompt);
    fd.set('url', url);
    files.forEach((f) => fd.append('files', f));
    await onSubmit(fd);
    setPrompt(''); setUrl(''); setFiles([]);
    setBusy(false);
  };

  return (
    <div className="hero">
      <h1>What do you want to market?</h1>
      <p className="sub">Drop a product URL, describe your offering, or attach content. Agents will research the market and run your marketing.</p>

      <div className="searchbox">
        <textarea
          placeholder="Describe your product or service… e.g. “A mobile app that helps freelancers track billable hours and auto-generate invoices.”"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); }}
        />
        <div className="url-row">
          <span className="ic">🔗</span>
          <input placeholder="https://your-product-or-website.com (optional)" value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>

        {files.length > 0 && (
          <div className="attach-list">
            {files.map((f, i) => (
              <span className="attach-pill" key={i}>
                📎 {f.name}
                <button onClick={() => setFiles(files.filter((_, j) => j !== i))}>×</button>
              </span>
            ))}
          </div>
        )}

        <div className="search-actions">
          <div className="chiprow">
            <button className="iconbtn" onClick={() => fileRef.current?.click()}>📎 Attach files / images</button>
            <input
              ref={fileRef} type="file" multiple hidden
              onChange={(e) => { setFiles([...files, ...Array.from(e.target.files || [])]); e.target.value = ''; }}
            />
          </div>
          <button className="submit" onClick={submit} disabled={busy || (!prompt.trim() && !url.trim())}>
            {busy ? 'Dispatching…' : 'Start marketing →'}
          </button>
        </div>
      </div>
      <p className="note" style={{ fontSize: 12, marginTop: 10 }}>⌘/Ctrl + Enter to start</p>
    </div>
  );
}

// ----------------------------- Job card -------------------------------------
// Compact row: just the title + status (+ controls). The full live activity and
// files live in the detail modal, opened by clicking the row.
function JobCard({ job, onOpen, onControl }: {
  job: Job; onOpen: () => void; onControl: (id: string, a: 'pause' | 'resume') => void;
}) {
  const canPause = ['running', 'queued'].includes(job.status);
  const canResume = ['paused', 'error'].includes(job.status);

  return (
    <div className="job">
      <div className="job-head" onClick={onOpen}>
        <span className={`job-kind kind-${job.kind}`}>{job.kind}</span>
        <div className="job-title" style={{ flex: 1, minWidth: 0 }}>{job.title}</div>
        <div className="job-meta" onClick={(e) => e.stopPropagation()}>
          <StatusPill status={job.status} />
          {canPause && <button className="ctrl" title="Pause" onClick={() => onControl(job.id, 'pause')}>⏸</button>}
          {canResume && <button className="ctrl" title="Resume" onClick={() => onControl(job.id, 'resume')}>▶</button>}
          <button className="ctrl" title="Details" onClick={onOpen}>⤢</button>
        </div>
      </div>
    </div>
  );
}

function ActivityLine({ a }: { a: Activity }) {
  const label = ({ text: 'thinking', tool_use: 'tool', finding: 'learned', file: 'file', status: 'status', error: 'error', action: 'proposed' } as any)[a.kind] || a.kind;
  return (
    <div className="line">
      <span className={`badge b-${a.kind}`}>{label}</span>
      <span className="body">
        {a.label && <span className="lbl">{a.label}{a.content ? ' — ' : ''}</span>}
        {a.content}
      </span>
    </div>
  );
}

function FileRow({ f }: { f: FileRow }) {
  const ext = (f.name.split('.').pop() || 'file').toUpperCase().slice(0, 4);
  return (
    <div className="filerow">
      <div className="fi">{ext}</div>
      <div className="fn">
        <div className="n">{f.name}</div>
        <div className="m">{f.kind || 'file'} · {fmtBytes(f.size)}</div>
      </div>
      <a className="dl" href={`/api/files/${f.id}`}>Download</a>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const label = status === 'running' ? 'Working' : status[0].toUpperCase() + status.slice(1);
  return <span className={`status s-${status}`}><span className="pip" />{label}</span>;
}

function PhaseChip({ phase }: { phase: string }) {
  const label = phase === 'research' ? 'Researching' : phase === 'marketing' ? 'Marketing'
    : phase === 'execution' ? 'Executing' : 'Complete';
  return <span className={`phase-chip ph-${phase}`}>{label}</span>;
}

// ----------------------------- Job detail modal -----------------------------
function JobModal({ job, findings, files, onClose }: {
  job: Job; findings: Finding[]; files: FileRow[]; onClose: () => void;
}) {
  const activity = job.activity || [];
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h3>{job.title}</h3>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span className={`job-kind kind-${job.kind}`}>{job.kind}</span>
              <StatusPill status={job.status} />
            </div>
          </div>
          <button className="x" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {job.error && <div className="banner">{job.error}</div>}
          {job.summary && <p className="note" style={{ marginTop: 0 }}>{job.summary}</p>}

          {files.length > 0 && (
            <div className="kgroup">
              <h4>Deliverables · {files.length} file{files.length === 1 ? '' : 's'}</h4>
              <div className="files-inline">{files.map((f) => <FileRow key={f.id} f={f} />)}</div>
            </div>
          )}

          {findings.length > 0 && (
            <div className="kgroup">
              <h4>Knowledge gained · {findings.length}</h4>
              {findings.map((f) => (
                <div className="finding" key={f.id}>
                  <div className="ft">{f.category && <span className="cat">{f.category}</span>}{f.title}</div>
                  {f.summary && <div className="fs">{f.summary}</div>}
                  {f.details && <div className="fd">{f.details}</div>}
                </div>
              ))}
            </div>
          )}

          <div className="kgroup">
            <h4>Activity log · {activity.length}</h4>
            <div className="feed" style={{ maxHeight: 320, border: '1px solid var(--border)', borderRadius: 10 }}>
              {activity.length === 0 && <div className="note">No activity recorded yet.</div>}
              {activity.map((a) => <ActivityLine key={a.id} a={a} />)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ----------------------------- Campaign / execution -------------------------
const CH_LABEL: Record<string, string> = {
  webhook: 'Automation webhook', smtp: 'Email (SMTP)', x: 'X / Twitter', linkedin: 'LinkedIn',
  reddit: 'Reddit', instagram: 'Instagram', tiktok: 'TikTok', facebook: 'Facebook', youtube: 'YouTube',
  mastodon: 'Mastodon', threads: 'Threads', discord: 'Discord', hackernews: 'Hacker News',
  producthunt: 'Product Hunt', indiehackers: 'Indie Hackers', blog: 'Blog / SEO', email: 'Email outreach',
  influencer: 'Influencer', meta_ads: 'Meta Ads', google_ads: 'Google Ads', reddit_ads: 'Reddit Ads',
  tiktok_ads: 'TikTok Ads', x_ads: 'X Ads',
};
const chLabel = (k: string) => CH_LABEL[k] || k;
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

// Turn bare URLs in agent-written text into clickable links.
function linkify(text: string) {
  return text.split(/(https?:\/\/[^\s)]+)/g).map((p, i) =>
    /^https?:\/\//.test(p)
      ? <a key={i} href={p} target="_blank" rel="noreferrer">{p}</a>
      : <span key={i}>{p}</span>,
  );
}

function CampaignPanel({ campaign, actions, onDecide, onRevise, onOptimize, anyExecLive }: {
  campaign: Campaign; actions: ActionItem[]; onDecide: (id: string, a: 'approve' | 'reject') => void;
  onRevise: (id: string, feedback: string) => void; onOptimize: () => void; anyExecLive: boolean;
}) {
  const proposed = actions.filter((a) => ['proposed', 'revising'].includes(a.status));
  const live = actions.filter((a) => ['approved', 'done', 'ready'].includes(a.status));
  const rejected = actions.filter((a) => a.status === 'rejected' || a.status === 'failed');
  const pct = campaign.budget_cents > 0 ? Math.min(100, (campaign.spent_cents / campaign.budget_cents) * 100) : 0;

  return (
    <div className="campaign">
      <div className="budget">
        <div className="budget-head">
          <div>
            <div className="budget-label">Campaign budget {campaign.budget_cents === 0 && <span className="zero-pill">$0 — pure growth hacking</span>}</div>
            <div className="budget-nums">
              <b>{usd(campaign.spent_cents)}</b> committed · {usd(campaign.budget_cents - campaign.spent_cents)} remaining
              <span className="of"> of {usd(campaign.budget_cents)}</span>
            </div>
          </div>
          <button className="iconbtn" onClick={onOptimize} disabled={anyExecLive} title="Run an optimizer pass">✨ Optimize</button>
        </div>
        {campaign.budget_cents > 0 && <div className="meter"><div className="meter-fill" style={{ width: `${pct}%` }} /></div>}
        <div className="note" style={{ fontSize: 12, marginTop: 8 }}>
          Approval-gated — nothing is published or spent until you approve it. {anyExecLive && <span className="spin">⟳</span>} {anyExecLive && 'Agents are proposing actions…'}
        </div>
      </div>

      <div className="queue">
        <div className="queue-col-head">Needs your approval · {proposed.length}</div>
        {proposed.length === 0 && <div className="empty" style={{ padding: 18 }}>{anyExecLive ? 'Agents are still working…' : 'No actions waiting.'}</div>}
        {proposed.map((a) => <ActionCard key={a.id} a={a} onDecide={onDecide} onRevise={onRevise} />)}

        {live.length > 0 && <div className="queue-col-head" style={{ marginTop: 18 }}>Approved & executed · {live.length}</div>}
        {live.map((a) => <ActionCard key={a.id} a={a} onDecide={onDecide} onRevise={onRevise} />)}

        {rejected.length > 0 && <div className="note" style={{ fontSize: 12, marginTop: 14 }}>{rejected.length} rejected/failed.</div>}
      </div>
    </div>
  );
}

function ActionCard({ a, onDecide, onRevise }: {
  a: ActionItem; onDecide: (id: string, x: 'approve' | 'reject') => void; onRevise: (id: string, feedback: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState('');
  const meta = (() => { try { return a.meta ? JSON.parse(a.meta) : {}; } catch { return {}; } })();
  const revisions: { feedback: string; ts: number }[] = meta.revisions || [];
  const revising = a.status === 'revising';
  const copy = () => { navigator.clipboard?.writeText(a.content || ''); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  const send = () => { if (!feedback.trim()) return; onRevise(a.id, feedback.trim()); setFeedback(''); };

  return (
    <div className={`action a-${a.status}`}>
      <div className="action-head" onClick={() => setOpen(!open)}>
        <span className={`act-status as-${a.status}`}>{revising ? 'revising' : a.status}</span>
        <span className="job-kind kind-exec">{chLabel(a.channel)} · {a.kind}</span>
        {a.cost_cents > 0 && <span className="cost">{usd(a.cost_cents)}</span>}
        <div className="action-title">{a.title}</div>
        {revisions.length > 0 && <span className="rev-count" title={`${revisions.length} revision(s)`}>✎{revisions.length}</span>}
        <span className="caret">{open ? '▾' : '▸'}</span>
      </div>
      {a.summary && <div className="action-sum">{a.summary}</div>}

      {meta.signup_url && (
        <div className="signup-row">
          <a className="signup-link" href={meta.signup_url} target="_blank" rel="noreferrer">▶ Open {chLabel(a.channel)} signup ↗</a>
          {meta.handle && <span className="handle-pill">{String(meta.handle).startsWith('@') ? meta.handle : '@' + meta.handle}</span>}
          <span className="note" style={{ fontSize: 11 }}>Expand for the full profile to paste →</span>
        </div>
      )}

      {open && (
        <div className="action-body">
          {meta.targeting && <div className="kv"><b>Targeting</b> {meta.targeting}</div>}
          {meta.subject && <div className="kv"><b>Subject</b> {meta.subject}</div>}
          {meta.schedule && <div className="kv"><b>When</b> {meta.schedule}</div>}
          {meta.rationale && <div className="kv"><b>Why</b> {meta.rationale}</div>}
          {a.content && (
            <div className="action-content">
              <button className="copy" onClick={copy}>{copied ? '✓ Copied' : '⧉ Copy'}</button>
              <pre>{linkify(a.content)}</pre>
            </div>
          )}
          {revisions.length > 0 && (
            <div className="kv"><b>Your feedback</b>
              <ul className="rev-list">{revisions.map((r, i) => <li key={i}>{r.feedback}</li>)}</ul>
            </div>
          )}
          {a.result && <div className="kv"><b>Note</b> {a.result}</div>}
        </div>
      )}

      {revising && <div className="revising-bar"><span className="spin">⟳</span> Revising based on your feedback…</div>}

      {a.status === 'proposed' && (
        <>
          <div className="action-actions">
            <button className="approve" onClick={() => onDecide(a.id, 'approve')}>✓ Approve{a.cost_cents > 0 ? ` (${usd(a.cost_cents)})` : ''}</button>
            <button className="reject" onClick={() => onDecide(a.id, 'reject')}>✕ Reject</button>
          </div>
          <div className="feedback">
            <textarea
              placeholder="Adjust this action — e.g. “punchier hook, mention the free tier, target designers, drop the emoji”…"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); }}
            />
            <button className="revise-btn" onClick={send} disabled={!feedback.trim()}>↻ Revise</button>
          </div>
        </>
      )}

      {['ready', 'done'].includes(a.status) && a.result && <div className="action-result">{a.status === 'done' ? '✅ ' : '📋 '}{linkify(a.result)}</div>}
    </div>
  );
}

// ----------------------------- Launch modal ---------------------------------
function LaunchModal({ onClose, onLaunch }: { onClose: () => void; onLaunch: (budget: number, channels: string[]) => void }) {
  const [budget, setBudget] = useState('0');
  const [channels, setChannels] = useState<Channel[]>([]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/connectors').then((r) => r.json()).then((d: { connectors: Channel[] }) => {
      const list = d.connectors.filter((c) => c.category !== 'automation' && c.key !== 'smtp');
      setChannels(list);
      setSel(new Set(list.map((c) => c.key))); // default: everything on
    });
  }, []);

  const toggle = (k: string) => setSel((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const cats: Record<string, string> = { organic: 'Organic & social', community: 'Communities', content: 'Content / SEO', email: 'Email & outreach', influencer: 'Influencer', paid: 'Paid ads' };
  const grouped = Object.keys(cats).map((c) => ({ cat: c, items: channels.filter((ch) => ch.category === c) })).filter((g) => g.items.length);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 620 }}>
        <div className="modal-head">
          <div><h3>Launch growth campaign</h3><div className="note">A swarm of specialist agents will propose real actions within your budget. Every action needs your approval before anything goes live.</div></div>
          <button className="x" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div className="kgroup">
            <h4>Budget ceiling (hard cap)</h4>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 20, fontWeight: 700 }}>$</span>
              <input className="field" style={{ marginTop: 0, maxWidth: 160, fontSize: 18 }} type="number" min="0" step="1" value={budget} onChange={(e) => setBudget(e.target.value)} />
              <span className="note">Set <b>0</b> for pure organic / growth-hacking.</span>
            </div>
          </div>
          <div className="kgroup">
            <h4>Channels in scope</h4>
            {grouped.map((g) => (
              <div key={g.cat} style={{ marginBottom: 10 }}>
                <div className="note" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>{cats[g.cat]}</div>
                <div className="chips">
                  {g.items.map((ch) => (
                    <button key={ch.key} className={`chan-chip ${sel.has(ch.key) ? 'on' : ''}`} onClick={() => toggle(ch.key)}>
                      {sel.has(ch.key) ? '✓ ' : ''}{ch.label}{ch.connected ? ' 🔌' : ''}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <button className="submit" disabled={busy || sel.size === 0} onClick={async () => { setBusy(true); await onLaunch(Number(budget) || 0, [...sel]); setBusy(false); }}>
            {busy ? 'Launching swarm…' : `Launch swarm across ${sel.size} channel${sel.size === 1 ? '' : 's'} →`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ----------------------------- Channels modal -------------------------------
function ChannelsModal({ onClose, hasCampaign, hasProject, onCreate }: {
  onClose: () => void; hasCampaign: boolean; hasProject: boolean; onCreate: (channel: string) => Promise<string | null>;
}) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [hook, setHook] = useState('');
  const [smtp, setSmtp] = useState({ host: '', port: '587', user: '', pass: '', from: '' });

  const load = () => fetch('/api/connectors').then((r) => r.json()).then((d) => setChannels(d.connectors));
  useEffect(() => { load(); }, []);

  const connect = async (key: string, secrets: any) => {
    await fetch('/api/connectors', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, connect: true, secrets }) });
    load();
  };
  const disconnect = async (key: string) => {
    await fetch('/api/connectors', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, connect: false }) });
    load();
  };

  const webhookOn = channels.find((c) => c.key === 'webhook')?.connected;
  const smtpOn = channels.find((c) => c.key === 'smtp')?.connected;
  const others = channels.filter((c) => c.key !== 'webhook' && c.key !== 'smtp');

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
        <div className="modal-head">
          <div><h3>Channels & accounts</h3><div className="note">Connect accounts so approved actions execute automatically. Anything not connected stays publish-ready (copy-paste).</div></div>
          <button className="x" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div className="kgroup">
            <h4>Automation webhook {webhookOn && <span className="zero-pill">connected</span>}</h4>
            <p className="note">The universal bridge: approved posts/ads are POSTed here so Zapier / Make / n8n / Buffer publish them to any platform.</p>
            {webhookOn ? (
              <button className="reject" onClick={() => disconnect('webhook')}>Disconnect</button>
            ) : (
              <div style={{ display: 'flex', gap: 8 }}>
                <input className="field" style={{ marginTop: 0 }} placeholder="https://hooks.zapier.com/…" value={hook} onChange={(e) => setHook(e.target.value)} />
                <button className="approve" disabled={!hook.trim()} onClick={() => connect('webhook', { url: hook.trim() })}>Connect</button>
              </div>
            )}
          </div>

          <div className="kgroup">
            <h4>Email (SMTP) {smtpOn && <span className="zero-pill">connected</span>}</h4>
            <p className="note">Sends approved outreach/lifecycle email. An opt-out footer is added automatically.</p>
            {smtpOn ? (
              <button className="reject" onClick={() => disconnect('smtp')}>Disconnect</button>
            ) : (
              <div className="smtp-grid">
                <input className="field" placeholder="SMTP host" value={smtp.host} onChange={(e) => setSmtp({ ...smtp, host: e.target.value })} />
                <input className="field" placeholder="Port" value={smtp.port} onChange={(e) => setSmtp({ ...smtp, port: e.target.value })} />
                <input className="field" placeholder="Username" value={smtp.user} onChange={(e) => setSmtp({ ...smtp, user: e.target.value })} />
                <input className="field" type="password" placeholder="Password" value={smtp.pass} onChange={(e) => setSmtp({ ...smtp, pass: e.target.value })} />
                <input className="field" placeholder="From address" value={smtp.from} onChange={(e) => setSmtp({ ...smtp, from: e.target.value })} />
                <button className="approve" disabled={!smtp.host.trim()} onClick={() => connect('smtp', smtp)}>Connect</button>
              </div>
            )}
          </div>

          <div className="kgroup">
            <h4>Channels</h4>
            <p className="note">
              <b>Connect</b> an account so approved actions auto-execute, or let the swarm <b>Create</b> a name-matched
              brand account: an agent checks handle availability, writes your profile, and hands you a one-click signup
              link to finish (platforms require human verification, so the final step is yours).
            </p>
            <div className="chan-list">
              {others.map((c) => (
                <ChannelRow
                  key={c.key} c={c} webhookOn={!!webhookOn} smtpOn={!!smtpOn}
                  hasCampaign={hasCampaign} hasProject={hasProject}
                  onConnect={connect} onDisconnect={disconnect} onCreate={onCreate}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ChannelRow({ c, webhookOn, smtpOn, hasCampaign, hasProject, onConnect, onDisconnect, onCreate }: {
  c: Channel; webhookOn: boolean; smtpOn: boolean; hasCampaign: boolean; hasProject: boolean;
  onConnect: (key: string, secrets: any) => void; onDisconnect: (key: string) => void;
  onCreate: (channel: string) => Promise<string | null>;
}) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ handle: '', token: '', url: '' });
  const [creating, setCreating] = useState(false);
  const [createMsg, setCreateMsg] = useState<string | null>(null);

  const auto = c.connected || (c.executor === 'webhook' && webhookOn) || (c.executor === 'smtp' && smtpOn);
  const statusText = c.connected ? 'connected' : (c.executor === 'webhook' && webhookOn) ? 'via webhook'
    : (c.executor === 'smtp' && smtpOn) ? 'via SMTP' : c.executor === 'manual' ? 'publish-ready' : 'not connected';

  const save = () => {
    if (!f.handle && !f.token && !f.url) return;
    onConnect(c.key, { handle: f.handle || undefined, token: f.token || undefined, url: f.url || undefined });
    setOpen(false); setF({ handle: '', token: '', url: '' });
  };
  const create = async () => {
    setCreating(true); setCreateMsg(null);
    const err = await onCreate(c.key);
    setCreating(false);
    setCreateMsg(err ? `⚠ ${err}` : '✓ Agent is preparing it — check your action queue.');
    setTimeout(() => setCreateMsg(null), 6000);
  };

  return (
    <div className="chan-item">
      <div className="chan-main">
        <span className={`pip2 ${c.connected ? 'on' : auto ? 'auto' : ''}`} />
        <span className="cn">{c.label}{c.paid ? ' 💲' : ''}</span>
        <span className="cx">{statusText}</span>
        <div className="chan-btns">
          <button className="mini" disabled={!hasProject || !hasCampaign || creating} title={!hasProject ? 'Open a project first' : !hasCampaign ? 'Launch a campaign first' : 'Agent prepares a name-matched account'} onClick={create}>
            {creating ? <span className="spin">⟳</span> : '✨'} Create
          </button>
          {c.connected
            ? <button className="mini danger" onClick={() => onDisconnect(c.key)}>Disconnect</button>
            : <button className="mini" onClick={() => setOpen(!open)}>{open ? 'Cancel' : 'Connect'}</button>}
        </div>
      </div>
      {createMsg && <div className="chan-msg">{createMsg}</div>}
      {open && !c.connected && (
        <div className="chan-form">
          <input className="field" placeholder="@handle / username (optional)" value={f.handle} onChange={(e) => setF({ ...f, handle: e.target.value })} />
          <input className="field" placeholder="API key / access token (optional)" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} />
          <input className="field" placeholder="Posting webhook URL for this channel (optional)" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} />
          <button className="approve" onClick={save} disabled={!f.handle && !f.token && !f.url}>Save & connect</button>
          <div className="note" style={{ fontSize: 11 }}>Tip: a per-channel webhook URL routes this channel's approved actions straight to your automation.</div>
        </div>
      )}
    </div>
  );
}

// ----------------------------- Connect modal --------------------------------
function ConnectModal({ auth, onClose, reload }: { auth: Auth | null; onClose: () => void; reload: () => void }) {
  const [token, setToken] = useState('');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const save = async () => {
    await fetch('/api/auth/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    setToken(''); reload();
  };
  const test = async () => {
    setTesting(true); setResult(null);
    try {
      const r = await (await fetch('/api/auth/test', { method: 'POST' })).json();
      setResult(r.ok ? '✅ Connection works — Claude responded.' : `❌ ${r.error || 'No valid credentials.'}`);
    } catch (e: any) { setResult(`❌ ${e?.message || e}`); }
    setTesting(false); reload();
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 540 }}>
        <div className="modal-head">
          <div>
            <h3>Connect Claude</h3>
            <div className="note">This service runs agents on your Claude subscription.</div>
          </div>
          <button className="x" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div className={`status s-${auth?.connected ? 'running' : 'error'}`} style={{ marginBottom: 12 }}>
            <span className="pip" />{auth?.connected ? 'Connected' : 'Not connected'}
          </div>
          <p className="note">{auth?.detail}</p>

          <div className="kgroup" style={{ marginTop: 18 }}>
            <h4>Option A — use your logged-in subscription</h4>
            <p className="note">If you’re signed into Claude Code on this machine, agents use it automatically. Confirm it works:</p>
            <button className="iconbtn" onClick={test} disabled={testing}>
              {testing ? <span className="spin">⟳</span> : '🔌'} {testing ? 'Testing…' : 'Test connection'}
            </button>
            {result && <p className="note" style={{ marginTop: 8 }}>{result}</p>}
          </div>

          <div className="kgroup">
            <h4>Option B — paste a subscription token</h4>
            <p className="note">Generate one with:</p>
            <div className="codeline">claude setup-token</div>
            <input className="field" placeholder="Paste CLAUDE_CODE_OAUTH_TOKEN (or sk-ant- API key)" value={token} onChange={(e) => setToken(e.target.value)} />
            <button className="submit" style={{ marginTop: 10 }} onClick={save} disabled={!token.trim()}>Save & connect</button>
          </div>
        </div>
      </div>
    </div>
  );
}
