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
type Project = { id: string; title: string; prompt: string; url: string | null; phase: string; status: string; summary: string | null; updated_at: number; jobs?: Job[]; campaign_status?: string | null; live?: boolean };
type Campaign = { id: string; status: string; currency: string; budget_cents: number; spent_cents: number; daily_cap_cents: number; channels: string | null; autonomy: string; auto_posts: number; strategy: string | null };
type ActionItem = { id: string; channel: string; kind: string; title: string; summary: string | null; content: string | null; meta: string | null; cost_cents: number; status: string; scheduled_at?: number; result: string | null; job_id: string | null; auto?: boolean };
type EmailList = { id: string; name: string; total?: number; active?: number };
type Directive = { id: string; text: string; created_at: number };
type Detail = { project: Project; jobs: Job[]; findings: Finding[]; files: FileRow[]; campaign: Campaign | null; actions: ActionItem[]; lists?: EmailList[]; directives?: Directive[] };
type Auth = { connected: boolean; method: string; detail: string };
type MetaSel = { accounts: { id: string; name: string }[]; pages: { id: string; name: string }[]; ad_account_id: string; page_id: string; default_image_url: string; default_link: string; handle: string };
type Channel = { key: string; label: string; category: string; executor: string; paid: boolean; note?: string; connected: boolean; excluded?: boolean; meta?: MetaSel };

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
  const [showJobs, setShowJobs] = useState(true);
  const [showLists, setShowLists] = useState(false);
  const [showLaunch, setShowLaunch] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Handle the OAuth round-trip return (mastodon | x | reddit).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const provider = q.get('oauth'); const status = q.get('status');
    const label = ({ mastodon: 'Mastodon', x: 'X / Twitter', reddit: 'Reddit', linkedin: 'LinkedIn', meta_ads: 'Meta Ads' } as any)[provider || ''] || provider;
    if (provider === null) return;
    if (status === 'connected') { setNotice(`✅ ${label} connected — approved ${label} posts will now publish to your account automatically.`); setShowChannels(true); }
    else setError(`${label} connection failed or was cancelled. Please try again.`);
    window.history.replaceState({}, '', window.location.pathname);
  }, []);

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

  const addDirection = async (text: string) => {
    if (!currentId || !text.trim()) return;
    await fetch(`/api/projects/${currentId}/directives`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
    });
    loadDetail(currentId);
  };

  const runCompetitors = async (count: number) => {
    if (!currentId) return;
    setError(null);
    const res = await fetch(`/api/projects/${currentId}/competitors`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count }),
    });
    const d = await res.json();
    if (!res.ok) { setError(d.error || 'Could not start competitive analysis.'); return; }
    loadDetail(currentId);
  };

  const control = async (jobId: string, action: 'pause' | 'resume') => {
    await fetch(`/api/jobs/${jobId}/${action}`, { method: 'POST' });
    if (currentId) loadDetail(currentId);
    loadProjects();
  };

  // Pause / resume all autonomous activity for one app.
  const pauseProject = async (projectId: string, paused: boolean) => {
    await fetch(`/api/projects/${projectId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: paused ? 'pause' : 'resume' }),
    });
    if (currentId === projectId) loadDetail(projectId);
    loadProjects();
  };

  // Permanently delete an app and all its data.
  const deleteProject = async (projectId: string, title: string) => {
    if (!window.confirm(`Delete “${title}” and ALL its data — connected channels, posts, ads, PDFs, history? This cannot be undone.`)) return;
    await fetch(`/api/projects/${projectId}`, { method: 'DELETE' });
    if (currentId === projectId) { setCurrentId(null); }
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

  const decide = async (actionId: string, action: 'approve' | 'reject', list_id?: string) => {
    setError(null); setNotice(null);
    const res = await fetch(`/api/actions/${actionId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, list_id }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) setError(d.error || 'Action failed.');
    else if (action === 'approve') {
      if (d.status === 'failed') setError(`⚠ Publish failed: ${d.detail || 'unknown error'}`);
      else if (d.status === 'done') setNotice(`✅ ${d.detail || 'Published.'}`);
      else if (d.status === 'sent') setNotice(`📤 ${d.detail || 'Sent to your automation — awaiting confirmation.'}`);
      else if (d.status === 'ready') setNotice(d.detail || 'Approved — ready to publish.');
    }
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

  const generate = async () => {
    if (!currentId) return;
    const res = await fetch(`/api/projects/${currentId}/campaign`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'generate' }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok && d.error) setError(d.error);
    loadDetail(currentId);
  };

  const campaignAction = async (body: any) => {
    if (!currentId) return;
    const res = await fetch(`/api/projects/${currentId}/campaign`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then((r) => r.json()).catch(() => ({}));
    if (body.action === 'optimize_ads') {
      setError(null); setNotice(null);
      if (res.issues?.length) setError(`Spend sync: ${res.issues.join(' ')}`);
      else if (!res.liveAds) setNotice('No live ads launched through the app to sync yet. (Boosted posts or ads created directly in Meta aren’t tracked here.)');
      else setNotice(`Synced ${res.synced}/${res.liveAds} ad(s). Spend to date: $${((res.spentCents || 0) / 100).toFixed(2)}.`);
    }
    loadDetail(currentId);
  };

  const adControl = async (actionId: string, action: 'pause_ad' | 'resume_ad' | 'remove_ad') => {
    setError(null);
    const res = await fetch(`/api/actions/${actionId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok && d.error) setError(d.error);
    if (currentId) loadDetail(currentId);
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
        {notice && <div className="banner ok" style={{ marginTop: 20 }}>{notice}</div>}
        {error && <div className="banner" style={{ marginTop: 20 }}>{error}</div>}

        {/* ACTIVE PROJECT */}
        {detail && (
          <div className="section">
            <h2 className="section-toggle" onClick={() => setShowJobs((v) => !v)} style={{ cursor: 'pointer' }}>
              <span className="caret">{showJobs ? '▾' : '▸'}</span> Active · {detail.project.title}
              {' '}<PhaseChip phase={detail.project.phase} />
              {!showJobs && <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>· {detail.jobs.length} agent{detail.jobs.length === 1 ? '' : 's'} hidden</span>}
            </h2>
            <DirectionBox directives={detail.directives || []} onAdd={addDirection} />
            <CompetitivePanel
              analyzed={detail.findings.filter((f) => f.category === 'competitor').length}
              files={detail.files.filter((f) => /competitive/i.test(f.name))}
              live={detail.jobs.some((j) => j.kind === 'competitive' && j.live)}
              onRun={runCompetitors}
            />
            {showJobs && (
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
            )}

            {/* Execution phase: campaign + action queue, or a CTA to launch it */}
            {detail.campaign ? (
              <CampaignPanel
                campaign={detail.campaign}
                actions={detail.actions}
                onDecide={decide}
                onRevise={revise}
                onOptimize={optimize}
                onGenerate={generate}
                onOpenChannels={() => setShowChannels(true)}
                onOpenLists={() => setShowLists(true)}
                onCampaignAction={campaignAction}
                onAdControl={adControl}
                lists={detail.lists || []}
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
              {projects.map((p) => {
                const paused = p.campaign_status === 'paused';
                const pausable = p.campaign_status === 'active' || p.live;
                return (
                <div key={p.id} className="hist-card" onClick={() => setCurrentId(p.id)}>
                  <div className="hist-card-top">
                    <div className="t">{p.title}</div>
                    <div className="hist-actions" onClick={(e) => e.stopPropagation()}>
                      {paused
                        ? <button className="mini" title="Resume autonomous marketing for this app" onClick={() => pauseProject(p.id, false)}>▶ Resume</button>
                        : pausable && <button className="mini" title="Pause all autonomous marketing for this app" onClick={() => pauseProject(p.id, true)}>⏸ Pause</button>}
                      <button className="mini danger" title="Delete this app and all its data" onClick={() => deleteProject(p.id, p.title)}>🗑</button>
                    </div>
                  </div>
                  <div className="d">{p.summary || p.prompt}</div>
                  <div className="foot">
                    <PhaseChip phase={p.phase} />
                    {paused && <span className="paused-tag">paused</span>}
                    <span>{(p.jobs?.length || 0)} job{(p.jobs?.length || 0) === 1 ? '' : 's'} · {ago(p.updated_at)}</span>
                  </div>
                </div>
                );
              })}
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
      {showChannels && currentId && <ChannelsModal projectId={currentId} onClose={() => setShowChannels(false)} hasCampaign={!!detail?.campaign} hasProject={!!currentId} onCreate={createAccount} />}
      {showLaunch && detail && currentId && <LaunchModal projectId={currentId} onClose={() => setShowLaunch(false)} onLaunch={launchCampaign} />}
      {showLists && currentId && <EmailListsModal projectId={currentId} onClose={() => setShowLists(false)} onChanged={() => currentId && loadDetail(currentId)} />}
    </>
  );
}

// ------------------------ Competitive advantage -----------------------------
// Always-available card: shows competitors analyzed so far + the generated PDF,
// and lets the user run it again for N MORE competitors at any stage.
function CompetitivePanel({ analyzed, files, live, onRun }: {
  analyzed: number; files: FileRow[]; live: boolean; onRun: (count: number) => void;
}) {
  const [count, setCount] = useState(5);
  const [open, setOpen] = useState(false);
  return (
    <div className="comp-panel">
      <div className="comp-head">
        <span className="comp-title">🔍 Competitive advantage</span>
        <span className="comp-stat">{analyzed} competitor{analyzed === 1 ? '' : 's'} analyzed</span>
        {live && <span className="auto-working"><span className="spin">⟳</span> analyzing…</span>}
        <div style={{ flex: 1 }} />
        {!open && <button className="mini" disabled={live} onClick={() => setOpen(true)}>{analyzed ? 'Analyze more' : 'Analyze competitors'}</button>}
      </div>
      {files.length > 0 && (
        <div className="files-inline" style={{ marginTop: 8 }}>{files.map((f) => <FileRow key={f.id} f={f} />)}</div>
      )}
      {open && (
        <div className="comp-run">
          <label className="adctl-field"><span>Analyze</span>
            <input className="mini-input" type="number" min={1} max={25} value={count} onChange={(e) => setCount(Math.max(1, Math.min(25, Number(e.target.value) || 1)))} />
            <span>{analyzed ? 'more (new) competitors' : 'top competitors'}</span>
          </label>
          <button className="mini" disabled={live} onClick={() => { onRun(count); setOpen(false); }}>{live ? 'Running…' : 'Run analysis'}</button>
          <button className="mini" onClick={() => setOpen(false)}>Cancel</button>
          {analyzed > 0 && <span className="note" style={{ fontSize: 11 }}>Already-analyzed competitors are excluded automatically.</span>}
        </div>
      )}
    </div>
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

// ----------------------------- Direction box --------------------------------
// Project-level steering: free-form guidance that shapes the whole approach.
function DirectionBox({ directives, onAdd }: { directives: Directive[]; onAdd: (t: string) => Promise<void> | void }) {
  const [open, setOpen] = useState(true);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => { if (!text.trim()) return; setBusy(true); await onAdd(text.trim()); setBusy(false); setText(''); };
  return (
    <div className="direction">
      <button className="dir-head" onClick={() => setOpen((v) => !v)}>
        <span className="caret">{open ? '▾' : '▸'}</span> 💬 Direction &amp; ideas{directives.length ? ` · ${directives.length}` : ''}
        <span className="dir-hint">steer the whole marketing approach</span>
      </button>
      {open && (
        <div className="dir-body">
          {directives.length > 0 && (
            <div className="dir-log">
              {directives.map((d) => <div className="dir-msg" key={d.id}>{d.text}<span className="dir-time">{ago(d.created_at)}</span></div>)}
            </div>
          )}
          <div className="dir-input">
            <textarea
              placeholder="Add a direction or idea that shapes everything — e.g. “lean into the anti-gatekeeper / underdog angle”, “emphasize the free tier”, “keep the tone witty, no corporate-speak”, “go after bedroom producers in the UK first”…"
              value={text} onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); }}
            />
            <button className="revise-btn" onClick={submit} disabled={busy || !text.trim()}>{busy ? <span className="spin">⟳</span> : 'Add direction'}</button>
          </div>
          <div className="note" style={{ fontSize: 11 }}>Applied to all future research, generation, optimization, and revisions. Hit ✨ Generate or ⚡ Optimize to use it now.</div>
        </div>
      )}
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
const fmtWhen = (ms: number) => {
  const d = new Date(ms);
  const day = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${day} at ${time}`;
};
const metaPaused = (a: ActionItem) => { try { return !!(a.meta && JSON.parse(a.meta).ad_paused); } catch { return false; } };

// Per-channel Make.com recipe: which module + which text field to map.
const WEBHOOK_RECIPE: Record<string, { action: string; field: string }> = {
  linkedin: { action: 'Create a Post', field: 'Text' },
  facebook: { action: 'Create a Post', field: 'Message' },
  instagram: { action: 'Create a Post', field: 'Caption' },
  youtube: { action: 'your upload/post module', field: 'Description' },
  blog: { action: 'your CMS “Create a Post” module', field: 'Body' },
  tiktok: { action: 'Upload a Video', field: 'Caption' },
};

function WebhookGuide({ channel }: { channel: string }) {
  const r = WEBHOOK_RECIPE[channel] || { action: 'your “Create a Post” module', field: 'the post-text field' };
  const label = chLabel(channel);
  return (
    <div className="guide">
      <div className="note" style={{ fontSize: 11.5, marginBottom: 6 }}>
        Routes approved {label} posts through <b>Make.com</b> (free — its webhooks run on the free tier, unlike Zapier). One-time setup:
      </div>
      <ol>
        <li>In <b>Make.com</b> → <b>Create a new scenario</b>. Add a module → search <b>Webhooks → Custom webhook</b> → <b>Add</b>, name it, and <b>Copy</b> the address it generates.</li>
        <li>Paste that address in the box below → <b>Connect &amp; test</b> (we send a ping so Make sees the hook).</li>
        <li>Add the next module → <b>{label} → {r.action}</b> → connect your {label} account.</li>
        <li>Map the <b>{r.field}</b> field to the webhook’s <code>content</code> (optionally a Title → <code>title</code>).</li>
        <li><b>Key step:</b> to make <code>content</code> appear, <b>Approve a {label} post here first</b>, then in Make click the Webhook module → <b>“Redetermine data structure”</b> so it captures the real payload (the <code>connection_test</code> ping has no <code>content</code>).</li>
        <li>Turn the scenario <b>ON</b> (toggle, bottom-left) — a saved-but-off scenario won’t run.</li>
        <li>Done — <b>Approve</b> a {label} action here and it posts through Make.</li>
      </ol>
      <div className="note" style={{ fontSize: 11 }}>Fields we send: <code>content</code> (post text), <code>title</code>, <code>summary</code>, <code>channel</code>, <code>callback_url</code>.</div>
      <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <a className="mini" href="https://www.make.com" target="_blank" rel="noreferrer">Open Make.com ↗</a>
      </div>
      <div className="note" style={{ fontSize: 11, marginTop: 6 }}>Prefer Zapier? Same flow with <b>Webhooks by Zapier → Catch Hook</b> (needs a paid Zapier plan).</div>
    </div>
  );
}

// Paste-ready answer for X's "describe all of your use cases" review field.
const X_USECASE = `This app is a personal marketing assistant used by a single authenticated user to manage their own brand's presence on X.

How we use the X API:
1. Posting (tweet.write): We publish tweets and threads to the authenticated user's own account. Every post is written and explicitly approved by the user inside our app before it is sent — nothing is posted automatically or without human review.
2. Account identification (users.read): On connection we call GET /2/users/me one time to confirm which account authorized the app and to display that handle back to the user.

What we do NOT do:
- We do not read, collect, store, or analyze other users' Tweets, profiles, or any X data.
- We do not perform automated engagement (no auto-follow, auto-like, auto-reply) and we do not generate spam.
- We do not display X content outside of X, and we do not aggregate, resell, or share any X data with third parties or government entities.

Access tokens are stored only on the user's own machine and are used solely to post the user's own approved marketing content on their behalf. Posting volume is low — a handful of human-approved posts.`;

// Turn bare URLs in agent-written text into clickable links.
function linkify(text: string) {
  return text.split(/(https?:\/\/[^\s)]+)/g).map((p, i) =>
    /^https?:\/\//.test(p)
      ? <a key={i} href={p} target="_blank" rel="noreferrer">{p}</a>
      : <span key={i}>{p}</span>,
  );
}

// Autonomous ad-spend controls: ledger, add funds, daily cap, autonomy, kill switch.
const AUTONOMY_LABELS: Record<string, string> = {
  approval: 'Approve every ad', auto_after_first: 'Approve 1st, then auto', autonomous: 'Fully autonomous', optimize_only: 'Auto-optimize only',
};
function AdControls({ campaign, onCampaignAction, liveAds }: { campaign: Campaign; onCampaignAction: (b: any) => void; liveAds: number }) {
  const [funds, setFunds] = useState('');
  const [cap, setCap] = useState(((campaign.daily_cap_cents || 0) / 100) ? String((campaign.daily_cap_cents || 0) / 100) : '');
  const paused = campaign.status === 'paused';
  const fullAuto = campaign.autonomy === 'autonomous' && !!campaign.auto_posts;
  return (
    <div className="adctl">
      <label className="fullauto-row" title="Smart-schedules & publishes organic posts at the best times per channel, and auto-launches/optimizes/pauses ads — all inside your caps + kill switch.">
        <input type="checkbox" checked={fullAuto} onChange={(e) => onCampaignAction({ action: 'full_auto', on: e.target.checked })} />
        <span className="fullauto-label">🤖 Fully automated marketing {fullAuto ? <b className="fa-on">ON</b> : <span className="fa-off">off</span>}</span>
        <span className="note" style={{ fontSize: 11 }}>Posts publish on a smart per-channel schedule; ads auto-launch & auto-pause on performance. Caps + kill switch still apply.</span>
      </label>
      <div className="adctl-row">
        <div className="adctl-stat"><span className="lbl">Funded</span><b>{usd(campaign.budget_cents)}</b></div>
        <div className="adctl-stat"><span className="lbl">Spent</span><b>{usd(campaign.spent_cents)}</b></div>
        <div className="adctl-stat"><span className="lbl">Remaining</span><b className="rem">{usd(Math.max(0, campaign.budget_cents - campaign.spent_cents))}</b></div>
        <div className="adctl-stat"><span className="lbl">Live ads</span><b>{liveAds}</b></div>
        <button className={`kill ${paused ? 'on' : ''}`} title="Pause/resume all ad spend immediately" onClick={() => onCampaignAction({ action: 'kill', paused: !paused })}>
          {paused ? '▶ Resume ads' : '⏹ Kill switch'}
        </button>
      </div>
      <div className="adctl-row">
        <label className="adctl-field"><span>Funds $</span>
          <input className="mini-input" type="number" min="0" value={funds} onChange={(e) => setFunds(e.target.value)} placeholder="100" />
          <button className="mini" disabled={!Number(funds)} onClick={() => { onCampaignAction({ action: 'add_funds', amount_usd: Number(funds) }); setFunds(''); }}>＋ Add</button>
          <button className="mini" disabled={!Number(funds)} title="Lower the budget (can't go below what's already been spent)" onClick={() => { onCampaignAction({ action: 'remove_funds', amount_usd: Number(funds) }); setFunds(''); }}>－ Remove</button>
        </label>
        <label className="adctl-field"><span>Daily cap $</span>
          <input className="mini-input" type="number" min="0" value={cap} onChange={(e) => setCap(e.target.value)} placeholder="none" />
          <button className="mini" onClick={() => onCampaignAction({ action: 'daily_cap', amount_usd: Number(cap) || 0 })}>Set</button>
        </label>
        <label className="adctl-field"><span>Autonomy</span>
          <select className="list-select" value={campaign.autonomy} onChange={(e) => onCampaignAction({ action: 'autonomy', mode: e.target.value })}>
            {Object.entries(AUTONOMY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <button className="mini" title="Spend auto-syncs while this project is open and every 5 min in the background; click to refresh now." onClick={() => onCampaignAction({ action: 'optimize_ads' })}>↻ Sync now</button>
      </div>
      {liveAds > 0 && <div className="note" style={{ fontSize: 11 }}>Spend auto-syncs from the ad platform while this project is open (and every 5 min in the background); ads auto-pause at the cap.</div>}
      {campaign.daily_cap_cents > 0 && <div className="note" style={{ fontSize: 11 }}>Hard rails: total cap {usd(campaign.budget_cents)} · daily cap {usd(campaign.daily_cap_cents)}. At the cap, ads auto-pause.</div>}
    </div>
  );
}

function CampaignPanel({ campaign, actions, onDecide, onRevise, onOptimize, onGenerate, onOpenChannels, onOpenLists, onCampaignAction, onAdControl, lists, anyExecLive }: {
  campaign: Campaign; actions: ActionItem[]; onDecide: (id: string, a: 'approve' | 'reject', list_id?: string) => void;
  onRevise: (id: string, feedback: string) => void; onOptimize: () => void; onGenerate: () => void;
  onOpenChannels: () => void; onOpenLists: () => void; onCampaignAction: (body: any) => void;
  onAdControl: (id: string, a: 'pause_ad' | 'resume_ad' | 'remove_ad') => void; lists: EmailList[]; anyExecLive: boolean;
}) {
  const [autoOnly, setAutoOnly] = useState(true);
  const [showLive, setShowLive] = useState(false);
  const allProposed = actions.filter((a) => ['proposed', 'revising'].includes(a.status));
  const proposed = autoOnly ? allProposed.filter((a) => a.auto) : allProposed;
  const hiddenManual = allProposed.length - proposed.length;
  const scheduled = actions.filter((a) => a.status === 'scheduled').sort((x, y) => (x.scheduled_at || 0) - (y.scheduled_at || 0));
  const live = actions.filter((a) => ['approved', 'done', 'ready', 'sent'].includes(a.status));
  const failed = actions.filter((a) => a.status === 'failed');
  const rejected = actions.filter((a) => a.status === 'rejected');
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
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="iconbtn" onClick={onGenerate} disabled={anyExecLive} title="Generate fresh actions for your connected channels">✨ Generate actions</button>
            <button className="iconbtn" onClick={onOptimize} disabled={anyExecLive} title="Review & improve existing actions">⚡ Optimize</button>
            <button className="iconbtn" onClick={onOpenLists} title="Manage email recipient lists">✉️ Email lists</button>
          </div>
        </div>
        {campaign.budget_cents > 0 && <div className="meter"><div className="meter-fill" style={{ width: `${pct}%` }} /></div>}
        <AdControls campaign={campaign} onCampaignAction={onCampaignAction} liveAds={actions.filter((a) => a.kind === 'ad' && a.status === 'done' && !metaPaused(a)).length} />
        {campaign.auto_posts ? (
          <div className="auto-banner">
            <div className="auto-banner-head">
              <span className="fa-on">🤖 Autonomous marketing is ON</span>
              {anyExecLive
                ? <span className="auto-working"><span className="spin">⟳</span> agents generating…</span>
                : scheduled.length === 0 && <span className="auto-working"><span className="spin">⟳</span> queuing the next batch…</span>}
            </div>
            <div className="auto-banner-stats">
              <span>⏱ <b>{scheduled.length}</b> post{scheduled.length === 1 ? '' : 's'} scheduled</span>
              {scheduled[0]?.scheduled_at && <span>· next publishes <b>{fmtWhen(scheduled[0].scheduled_at)}</b></span>}
              <span>· <b>{actions.filter((a) => a.kind === 'ad' && a.status === 'done' && !metaPaused(a)).length}</b> live ad(s)</span>
            </div>
            {scheduled.length === 0 && !anyExecLive && (
              <div className="note" style={{ fontSize: 11.5 }}>
                No posts queued for your connected channels yet — the swarm generates a fresh batch automatically (it just needs connected organic channels like X / LinkedIn / Mastodon). You can also hit <b>✨ Generate actions</b> to kick it off now.
              </div>
            )}
            <div className="note" style={{ fontSize: 11.5 }}>
              Posts generate &amp; publish on their own at the best time per channel; ads auto-launch &amp; auto-pause on performance. The pipeline refills itself — no clicks needed. Caps + kill switch still apply. Email/influencer still need a list + your OK.
            </div>
          </div>
        ) : (
          <div className="note" style={{ fontSize: 12, marginTop: 8 }}>
            Posts are approval-gated. Ad spend follows your autonomy mode, always inside the total + daily caps and the kill switch. {anyExecLive && <span className="spin">⟳</span>} {anyExecLive && 'Agents are working…'}
          </div>
        )}
      </div>

      <div className="queue">
        <div className="queue-head-row">
          <div className="queue-col-head" style={{ margin: 0 }}>Needs your approval · {proposed.length}</div>
          <label className="auto-toggle">
            <input type="checkbox" checked={autoOnly} onChange={(e) => setAutoOnly(e.target.checked)} />
            Only show actions I can auto-publish
          </label>
        </div>
        {proposed.length === 0 && <div className="empty" style={{ padding: 18 }}>{anyExecLive ? 'Agents are still working…' : autoOnly && hiddenManual > 0 ? 'No auto-publishable actions yet — connect more channels under ⚙ Channels.' : 'No actions waiting.'}</div>}
        {proposed.map((a) => <ActionCard key={a.id} a={a} onDecide={onDecide} onRevise={onRevise} onOpenChannels={onOpenChannels} lists={lists} onOpenLists={onOpenLists} onAdControl={onAdControl} />)}
        {hiddenManual > 0 && (
          <div className="note" style={{ fontSize: 12, marginTop: 8 }}>
            {autoOnly ? `${hiddenManual} manual / unconnected action${hiddenManual === 1 ? '' : 's'} hidden. ` : ''}
            {autoOnly
              ? <a onClick={() => setAutoOnly(false)} style={{ cursor: 'pointer' }}>Show all</a>
              : <a onClick={() => setAutoOnly(true)} style={{ cursor: 'pointer' }}>Hide manual ones</a>}
          </div>
        )}

        {scheduled.length > 0 && (
          <div className="queue-col-head" style={{ marginTop: 18 }} title="Smart-scheduled — these publish automatically at the listed time">⏱ Scheduled to auto-publish · {scheduled.length}</div>
        )}
        {scheduled.map((a) => <ActionCard key={a.id} a={a} onDecide={onDecide} onRevise={onRevise} onOpenChannels={onOpenChannels} lists={lists} onOpenLists={onOpenLists} onAdControl={onAdControl} />)}

        {failed.length > 0 && <div className="queue-col-head" style={{ marginTop: 18, color: 'var(--red)' }}>⚠ Failed — needs attention · {failed.length}</div>}
        {failed.map((a) => <ActionCard key={a.id} a={a} onDecide={onDecide} onRevise={onRevise} onOpenChannels={onOpenChannels} lists={lists} onOpenLists={onOpenLists} onAdControl={onAdControl} />)}

        {live.length > 0 && (
          <button className="queue-col-head section-toggle" style={{ marginTop: 18 }} onClick={() => setShowLive((v) => !v)}>
            <span className="caret">{showLive ? '▾' : '▸'}</span> Approved &amp; executed · {live.length}
          </button>
        )}
        {showLive && live.map((a) => <ActionCard key={a.id} a={a} onDecide={onDecide} onRevise={onRevise} onOpenChannels={onOpenChannels} lists={lists} onOpenLists={onOpenLists} onAdControl={onAdControl} />)}

        {rejected.length > 0 && <div className="note" style={{ fontSize: 12, marginTop: 14 }}>{rejected.length} rejected.</div>}
      </div>
    </div>
  );
}

function ActionCard({ a, onDecide, onRevise, onOpenChannels, lists = [], onOpenLists, onAdControl }: {
  a: ActionItem; onDecide: (id: string, x: 'approve' | 'reject', list_id?: string) => void; onRevise: (id: string, feedback: string) => void;
  onOpenChannels: () => void; lists?: EmailList[]; onOpenLists?: () => void;
  onAdControl?: (id: string, a: 'pause_ad' | 'resume_ad' | 'remove_ad') => void;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [acting, setActing] = useState(false);
  const meta = (() => { try { return a.meta ? JSON.parse(a.meta) : {}; } catch { return {}; } })();
  const revisions: { feedback: string; ts: number }[] = meta.revisions || [];
  const revising = a.status === 'revising';
  const auto = !!a.auto;
  const isEmail = ['email', 'outreach'].includes(a.kind);
  const [listId, setListId] = useState<string>(meta.list_id || '');
  const approve = async () => { setActing(true); await onDecide(a.id, 'approve', isEmail ? listId : undefined); setActing(false); };
  const copy = () => { navigator.clipboard?.writeText(a.content || ''); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  const send = () => { if (!feedback.trim()) return; onRevise(a.id, feedback.trim()); setFeedback(''); };

  return (
    <div className={`action a-${a.status}`}>
      <div className="action-head" onClick={() => setOpen(!open)}>
        <span className={`act-status as-${a.status}`}>{revising ? 'revising' : a.status}</span>
        <span className="job-kind kind-exec">{chLabel(a.channel)} · {a.kind}</span>
        {a.cost_cents > 0 && <span className="cost">{usd(a.cost_cents)}</span>}
        <div className="action-title">{a.title}</div>
        {meta.angle && <span className="angle-pill" title="Messaging angle — kept distinct from previous posts to avoid looking repetitive">🎯 {meta.angle}</span>}
        {a.status === 'proposed' && (auto
          ? <span className="auto-pill on" title="Approving this publishes it automatically">⚡ auto</span>
          : <span className="auto-pill off" title="Connect this channel to auto-publish">manual</span>)}
        {revisions.length > 0 && <span className="rev-count" title={`${revisions.length} revision(s)`}>✎{revisions.length}</span>}
        <span className="caret">{open ? '▾' : '▸'}</span>
      </div>
      {a.summary && <div className="action-sum">{a.summary}</div>}

      {a.kind === 'reply' && meta.reply_to_url && (
        <div className="reply-ctx">
          <a className="signup-link" href={meta.reply_to_url} target="_blank" rel="noreferrer">↩ Replying to this {chLabel(a.channel)} post ↗</a>
          {meta.reply_to_context && <div className="reply-quote">“{meta.reply_to_context}”</div>}
          <div className="note" style={{ fontSize: 11 }}>Review the thread before approving — it posts as a public reply from your account.</div>
        </div>
      )}

      {a.status === 'scheduled' && a.scheduled_at ? (
        <>
          <div className="signup-row">
            <span className="auto-pill on">⏱ auto-publishes {fmtWhen(a.scheduled_at)}</span>
            <button className="mini" disabled={acting} onClick={async () => { setActing(true); await onDecide(a.id, 'approve', isEmail ? listId : undefined); setActing(false); }}>Publish now</button>
            <button className="mini" disabled={acting} title="Cancel the schedule and discard" onClick={() => onDecide(a.id, 'reject')}>Cancel</button>
          </div>
          <div className="feedback">
            <textarea
              placeholder="Adjust this scheduled post before it goes out — e.g. “punchier hook, mention the free tier, drop the emoji”…"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); }}
            />
            <button className="revise-btn" onClick={send} disabled={!feedback.trim()}>↻ Revise</button>
          </div>
        </>
      ) : null}

      {meta.paused_reason && (
        <div className="note" style={{ fontSize: 12, color: 'var(--amber, #b8860b)' }}>⏸ {meta.paused_reason}</div>
      )}
      {a.kind === 'ad' && a.status === 'done' && meta.perf && !meta.ad_paused && (
        <div className="note" style={{ fontSize: 11 }}>
          {usd(meta.perf.spend_cents)} spent · {Number(meta.perf.impressions || 0).toLocaleString()} impressions · {Number(meta.perf.clicks || 0).toLocaleString()} clicks · CTR {((meta.perf.ctr || 0) * 100).toFixed(2)}%
        </div>
      )}

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
          {a.result && <div className="action-result" style={{ color: 'var(--amber)' }}>⚠ {linkify(a.result)}</div>}
          {auto && isEmail && (
            <div className="list-row">
              <span className="note" style={{ fontSize: 12 }}>Send to:</span>
              <select className="list-select" value={listId} onChange={(e) => setListId(e.target.value)}>
                <option value="">— choose an email list —</option>
                {lists.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.active ?? 0})</option>)}
              </select>
              <button className="mini" onClick={onOpenLists}>✉️ Manage lists</button>
            </div>
          )}
          <div className="action-actions">
            {auto
              ? <button className="approve" onClick={approve} disabled={acting || (isEmail && !listId)} title={isEmail && !listId ? 'Choose a list first' : ''}>{acting ? <><span className="spin">⟳</span> {isEmail ? 'Sending…' : 'Publishing…'}</> : <>✓ Approve &amp; {isEmail ? 'send' : 'publish'}{a.cost_cents > 0 ? ` (${usd(a.cost_cents)})` : ''}</>}</button>
              : <button className="approve" onClick={onOpenChannels} title="This channel isn’t connected">🔌 Connect to enable</button>}
            <button className="reject" onClick={() => onDecide(a.id, 'reject')} disabled={acting}>✕ Reject</button>
          </div>
          {!auto && <div className="note" style={{ fontSize: 11.5, padding: '0 14px 8px' }}>{a.kind === 'account' ? 'Manual account setup — can’t be auto-published.' : `Connect ${chLabel(a.channel)} under ⚙ Channels and this will publish on approve.`}</div>}
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

      {['ready', 'done', 'sent'].includes(a.status) && a.result && (
        <div className="action-result">
          {a.status === 'done' ? '✅ ' : a.status === 'sent' ? '📤 ' : '📋 '}{linkify(a.result)}
          {meta.live_url && <> · <a href={meta.live_url} target="_blank" rel="noreferrer">View live ↗</a></>}
        </div>
      )}
      {a.kind === 'ad' && a.status === 'done' && onAdControl && (
        <div className="action-actions">
          <span className={`act-status ${meta.ad_paused ? 'as-ready' : 'as-done'}`}>{meta.ad_paused ? '⏸ paused' : '● live'}</span>
          {meta.ad_paused
            ? <button className="approve" onClick={() => onAdControl(a.id, 'resume_ad')}>▶ Resume</button>
            : <button className="reject" onClick={() => onAdControl(a.id, 'pause_ad')}>⏸ Pause</button>}
          <button className="reject" onClick={() => onAdControl(a.id, 'remove_ad')}>🗑 Remove</button>
        </div>
      )}

      {a.status === 'failed' && (
        <>
          {a.result && <div className="action-result" style={{ color: 'var(--red)' }}>⚠ {linkify(a.result)}</div>}
          <div className="action-actions">
            {auto && <button className="approve" onClick={approve} disabled={acting}>{acting ? <><span className="spin">⟳</span> Publishing…</> : '↻ Retry'}</button>}
            {!auto && <button className="approve" onClick={onOpenChannels} title="This channel isn’t connected">🔌 Connect to enable</button>}
            <button className="reject" onClick={() => onDecide(a.id, 'reject')} disabled={acting}>✕ Dismiss</button>
          </div>
        </>
      )}
    </div>
  );
}

// ----------------------------- Launch modal ---------------------------------
function LaunchModal({ projectId, onClose, onLaunch }: { projectId: string; onClose: () => void; onLaunch: (budget: number, channels: string[]) => void }) {
  const [budget, setBudget] = useState('0');
  const [channels, setChannels] = useState<Channel[]>([]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`/api/connectors?project=${projectId}`).then((r) => r.json()).then((d: { connectors: Channel[] }) => {
      const list = d.connectors.filter((c) => c.category !== 'automation' && c.key !== 'smtp');
      setChannels(list);
      setSel(new Set(list.map((c) => c.key))); // default: everything on
    });
  }, [projectId]);

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

// Pre-filled, copy-paste answer for X's API use-case review question.
function UseCaseBlock() {
  const [copied, setCopied] = useState(false);
  const copy = () => { navigator.clipboard?.writeText(X_USECASE); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  return (
    <div>
      <div className="note" style={{ fontSize: 11.5, marginTop: 2 }}>X asks <b>“Describe all of your use cases of X’s data and API”</b> — paste this:</div>
      <div className="action-content" style={{ marginTop: 6 }}>
        <button className="copy" onClick={copy}>{copied ? '✓ Copied' : '⧉ Copy'}</button>
        <pre style={{ maxHeight: 150, overflow: 'auto' }}>{X_USECASE}</pre>
      </div>
      <div className="note" style={{ fontSize: 11 }}>For the Yes/No questions (analyze X content, display Tweets off X, share data with government) answer <b>No</b>.</div>
    </div>
  );
}

// ----------------------------- Email lists modal ----------------------------
function EmailListsModal({ projectId, onClose, onChanged }: { projectId: string; onClose: () => void; onChanged: () => void }) {
  const [data, setData] = useState<{ lists: EmailList[]; suppressions: { email: string }[] }>({ lists: [], suppressions: [] });
  const [target, setTarget] = useState('new');
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [supp, setSupp] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => fetch(`/api/projects/${projectId}/lists`).then((r) => r.json()).then(setData).catch(() => {});
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const post = async (body: any) => {
    setBusy(true);
    const r = await fetch(`/api/projects/${projectId}/lists`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json()).catch(() => ({}));
    setBusy(false); await load(); onChanged();
    return r;
  };
  const submitRecipients = async () => {
    if (!text.trim()) return;
    const r = target === 'new' ? await post({ action: 'create', name: name || 'List', text }) : await post({ action: 'add', list_id: target, text });
    setMsg(`Added ${r.added ?? 0} recipient(s)${r.parsed != null ? ` of ${r.parsed} parsed` : ''}.`);
    setText(''); if (target === 'new') setName('');
  };
  const suppress = async () => { if (!supp.trim()) return; const r = await post({ action: 'suppress', text: supp }); setMsg(`Suppressed ${r.suppressed ?? 0} address(es).`); setSupp(''); };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 620 }}>
        <div className="modal-head">
          <div><h3>Email lists</h3><div className="note">Recipient lists for email outreach. Paste addresses or a CSV — the agent personalizes and the app sends, skipping anyone who unsubscribed.</div></div>
          <button className="x" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div className="kgroup">
            <h4>Add recipients</h4>
            <div style={{ display: 'flex', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
              <select className="list-select" value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="new">➕ New list…</option>
                {data.lists.map((l) => <option key={l.id} value={l.id}>Add to: {l.name}</option>)}
              </select>
              {target === 'new' && <input className="field" style={{ marginTop: 0, flex: 1, minWidth: 160 }} placeholder="List name (e.g. Industry scouts)" value={name} onChange={(e) => setName(e.target.value)} />}
            </div>
            <textarea className="field" style={{ minHeight: 100 }} placeholder={'Paste emails — one per line, or CSV with headers:\nemail,name,company\njane@label.com,Jane Doe,Big Records\nrep@studio.com'} value={text} onChange={(e) => setText(e.target.value)} />
            <button className="submit" style={{ marginTop: 8 }} disabled={busy || !text.trim()} onClick={submitRecipients}>{busy ? 'Saving…' : (target === 'new' ? 'Create list & add' : 'Add to list')}</button>
            {msg && <div className="note" style={{ marginTop: 6 }}>{msg}</div>}
            <div className="note" style={{ fontSize: 11, marginTop: 6 }}>Personalize copy with <code>{'{{name}}'}</code>, <code>{'{{first_name}}'}</code>, <code>{'{{company}}'}</code>.</div>
          </div>

          <div className="kgroup">
            <h4>Lists · {data.lists.length}</h4>
            {data.lists.length === 0 && <div className="note">No lists yet.</div>}
            {data.lists.map((l) => (
              <div className="filerow" key={l.id}>
                <div className="fn"><div className="n">{l.name}</div><div className="m">{l.active ?? 0} active · {l.total ?? 0} total</div></div>
                <button className="reject" onClick={() => post({ action: 'delete', list_id: l.id })}>Delete</button>
              </div>
            ))}
          </div>

          <div className="kgroup">
            <h4>Suppressed (never email) · {data.suppressions.length}</h4>
            <p className="note">These addresses are skipped on every send. Unsubscribes land here automatically; you can also add some manually.</p>
            <textarea className="field" style={{ minHeight: 60 }} placeholder="Paste emails to suppress…" value={supp} onChange={(e) => setSupp(e.target.value)} />
            <button className="reject" style={{ marginTop: 8 }} disabled={busy || !supp.trim()} onClick={suppress}>Add to suppression list</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ----------------------------- Channels modal -------------------------------
function ChannelsModal({ projectId, onClose, hasCampaign, hasProject, onCreate }: {
  projectId: string; onClose: () => void; hasCampaign: boolean; hasProject: boolean; onCreate: (channel: string) => Promise<string | null>;
}) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [hook, setHook] = useState('');
  const [smtp, setSmtp] = useState({ host: '', port: '587', user: '', pass: '', from: '' });

  const post = (body: any) => fetch('/api/connectors', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project_id: projectId, ...body }) });
  const load = () => fetch(`/api/connectors?project=${projectId}`).then((r) => r.json()).then((d) => setChannels(d.connectors));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [projectId]);

  const connect = async (key: string, secrets: any): Promise<{ connected: boolean; message: string }> => {
    const r = await post({ key, connect: true, secrets }).then((x) => x.json()).catch(() => ({ connected: false, message: 'Request failed.' }));
    await load();
    return r;
  };
  const disconnect = async (key: string) => { await post({ key, connect: false }); load(); };
  const setExclude = async (key: string, exclude: boolean) => { await post({ key, exclude }); load(); };
  const selectMeta = async (sel: any) => {
    await post(sel && sel.__refresh ? { key: 'meta_ads', refresh: true } : { key: 'meta_ads', select: sel });
    await load();
  };

  const [hookBusy, setHookBusy] = useState(false); const [hookMsg, setHookMsg] = useState<string | null>(null);
  const [smtpBusy, setSmtpBusy] = useState(false); const [smtpMsg, setSmtpMsg] = useState<string | null>(null);

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
            <h4>Automation webhook — catch-all fallback {webhookOn && <span className="zero-pill">connected</span>}</h4>
            <p className="note">
              One URL for channels you haven’t connected natively. Approved posts for those channels are POSTed here (each payload includes a <code>channel</code> field), and your Make / Zapier / n8n scenario routes them to the right place. Natively-connected channels (X, Mastodon, LinkedIn, Reddit) post directly and ignore this. Best for posts — not ads. A 200 means delivered to your automation, not confirmed live.
            </p>
            {webhookOn ? (
              <button className="reject" onClick={() => disconnect('webhook')}>Disconnect</button>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input className="field" style={{ marginTop: 0 }} placeholder="https://hooks.zapier.com/…" value={hook} onChange={(e) => setHook(e.target.value)} />
                  <button className="approve" disabled={!hook.trim() || hookBusy} onClick={async () => {
                    setHookBusy(true); setHookMsg(null);
                    const r = await connect('webhook', { url: hook.trim() });
                    setHookBusy(false); setHookMsg(r.message); if (r.connected) setHook('');
                  }}>{hookBusy ? <span className="spin">⟳</span> : 'Connect & test'}</button>
                </div>
                {hookMsg && <div className="note" style={{ fontSize: 12, marginTop: 6 }}>{hookMsg}</div>}
              </>
            )}
          </div>

          <div className="kgroup">
            <h4>Email (SMTP) {smtpOn && <span className="zero-pill">connected</span>}</h4>
            <p className="note">Your mail server — the <b>sending engine</b> behind the “Email outreach” and “Influencer” channels below (they have no separate login). Once connected, those channels can auto-send approved emails. An opt-out footer is added automatically, and the agent never invents recipients — you supply who to email.</p>
            {smtpOn ? (
              <button className="reject" onClick={() => disconnect('smtp')}>Disconnect</button>
            ) : (
              <>
                <div className="smtp-grid">
                  <input className="field" placeholder="SMTP host" value={smtp.host} onChange={(e) => setSmtp({ ...smtp, host: e.target.value })} />
                  <input className="field" placeholder="Port" value={smtp.port} onChange={(e) => setSmtp({ ...smtp, port: e.target.value })} />
                  <input className="field" placeholder="Username" value={smtp.user} onChange={(e) => setSmtp({ ...smtp, user: e.target.value })} />
                  <input className="field" type="password" placeholder="Password" value={smtp.pass} onChange={(e) => setSmtp({ ...smtp, pass: e.target.value })} />
                  <input className="field" placeholder="From address" value={smtp.from} onChange={(e) => setSmtp({ ...smtp, from: e.target.value })} />
                  <button className="approve" disabled={!smtp.host.trim() || smtpBusy} onClick={async () => {
                    setSmtpBusy(true); setSmtpMsg(null);
                    const r = await connect('smtp', smtp);
                    setSmtpBusy(false); setSmtpMsg(r.message);
                  }}>{smtpBusy ? <span className="spin">⟳</span> : 'Connect & test'}</button>
                </div>
                {smtpMsg && <div className="note" style={{ fontSize: 12, marginTop: 6 }}>{smtpMsg}</div>}
              </>
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
                  onConnect={connect} onDisconnect={disconnect} onCreate={onCreate} onExclude={setExclude} onMetaSelect={selectMeta} projectId={projectId}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Meta Ads: pick which ad account + Page to spend through, and a default ad image.
function MetaConfig({ meta, onSelect }: { meta: MetaSel; onSelect: (sel: any) => void }) {
  const [img, setImg] = useState(meta.default_image_url || '');
  const [link, setLink] = useState(meta.default_link || '');
  return (
    <div className="meta-cfg">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div className="note" style={{ fontSize: 11.5, fontWeight: 600 }}>Ad spend settings</div>
        <button className="mini" title="Re-fetch ad accounts & Pages from Meta (after creating a new one)" onClick={() => onSelect({ __refresh: true })}>↻ Refresh</button>
      </div>
      <label className="meta-field"><span>Ad account</span>
        <select className="list-select" value={meta.ad_account_id} onChange={(e) => onSelect({ ad_account_id: e.target.value })}>
          {!meta.accounts.length && <option value="">(no ad accounts found)</option>}
          {meta.accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.id})</option>)}
        </select>
      </label>
      <label className="meta-field"><span>Page</span>
        <select className="list-select" value={meta.page_id} onChange={(e) => onSelect({ page_id: e.target.value })}>
          {!meta.pages.length && <option value="">(no Pages found)</option>}
          {meta.pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <label className="meta-field"><span>Default destination URL</span>
        <input className="field" style={{ marginTop: 0 }} placeholder="https://your-website.com  (a WEBSITE, not an App Store link)" value={link} onChange={(e) => setLink(e.target.value)} />
        <button className="mini" onClick={() => onSelect({ default_link: link.trim() })}>Save</button>
      </label>
      <label className="meta-field"><span>Default ad image URL</span>
        <input className="field" style={{ marginTop: 0 }} placeholder="https://…/app-icon.png  (used when an ad has no image)" value={img} onChange={(e) => setImg(e.target.value)} />
        <button className="mini" onClick={() => onSelect({ default_image_url: img.trim() })}>Save</button>
      </label>
      <div className="note" style={{ fontSize: 11 }}>Ads link to the destination URL (use a website landing page — App Store links require Meta's App Installs objective). Every ad needs an image; agents find one, this is the fallback.</div>
    </div>
  );
}

function ChannelRow({ c, webhookOn, smtpOn, hasCampaign, hasProject, onConnect, onDisconnect, onCreate, onExclude, onMetaSelect, projectId }: {
  c: Channel; webhookOn: boolean; smtpOn: boolean; hasCampaign: boolean; hasProject: boolean;
  onConnect: (key: string, secrets: any) => Promise<{ connected: boolean; message: string }>;
  onDisconnect: (key: string) => void; onCreate: (channel: string) => Promise<string | null>;
  onExclude: (key: string, exclude: boolean) => void; onMetaSelect?: (sel: any) => void; projectId: string;
}) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ handle: '', token: '', url: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createMsg, setCreateMsg] = useState<string | null>(null);
  const [guide, setGuide] = useState(false);
  const [instance, setInstance] = useState('mastodon.social');
  const [cid, setCid] = useState('');
  const [csec, setCsec] = useState('');
  const [gDevToken, setGDevToken] = useState('');   // Google Ads developer token
  const [gCustomer, setGCustomer] = useState('');   // Google Ads customer id (the account that runs the ads)
  const [gManager, setGManager] = useState('');     // Google Ads manager (MCC) id, optional → login-customer-id
  const [webhookMode, setWebhookMode] = useState(false);
  const isOAuth = ['mastodon', 'x', 'reddit', 'linkedin', 'meta_ads', 'google_ads', 'reddit_ads'].includes(c.key);
  const isGoogleAds = c.key === 'google_ads';
  const redirectUri = (typeof window !== 'undefined' ? window.location.origin : '') + `/api/oauth/${c.key}/callback`;
  const portal = c.key === 'x' ? 'https://developer.twitter.com/en/portal/dashboard'
    : c.key === 'linkedin' ? 'https://www.linkedin.com/developers/apps'
    : c.key === 'meta_ads' ? 'https://developers.facebook.com/apps'
    : c.key === 'google_ads' ? 'https://console.cloud.google.com/apis/credentials'
    : c.key === 'reddit_ads' ? 'https://www.reddit.com/prefs/apps'
    : 'https://www.reddit.com/prefs/apps';

  const startOAuth = async (payload: any) => {
    setBusy(true); setMsg(null);
    const r = await fetch(`/api/oauth/${c.key}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, project_id: projectId }) })
      .then((x) => x.json()).catch(() => ({ error: 'Could not start.' }));
    if (r.url) { window.location.href = r.url; } // redirect to the platform's OAuth consent
    else { setBusy(false); setMsg(r.error || 'Could not start.'); }
  };

  const auto = c.connected || (c.executor === 'webhook' && webhookOn) || (c.executor === 'smtp' && smtpOn);
  const statusText = c.connected ? 'connected' : (c.executor === 'webhook' && webhookOn) ? 'auto via global webhook'
    : (c.executor === 'smtp' && smtpOn) ? 'auto via SMTP' : c.executor === 'manual' ? 'publish-ready' : 'publish-ready';

  const save = async () => {
    if (!f.url && !f.handle && !f.token) return;
    setBusy(true); setMsg(null);
    const r = await onConnect(c.key, { url: f.url || undefined, handle: f.handle || undefined, token: f.token || undefined });
    setBusy(false); setMsg(r.message);
    if (r.connected) { setOpen(false); setF({ handle: '', token: '', url: '' }); }
  };
  const create = async () => {
    setCreating(true); setCreateMsg(null);
    const err = await onCreate(c.key);
    setCreating(false);
    setCreateMsg(err ? `⚠ ${err}` : '✓ Agent is preparing it — check your action queue.');
    setTimeout(() => setCreateMsg(null), 7000);
  };

  return (
    <div className="chan-item">
      <div className="chan-main">
        <span className={`pip2 ${c.connected ? 'on' : auto ? 'auto' : ''}`} />
        <span className="cn">{c.label}{c.paid ? ' 💲' : ''}</span>
        <span className="cx">{statusText}</span>
        <div className="chan-btns">
          {['organic', 'community'].includes(c.category) && !c.paid && (
            <button className="mini" disabled={!hasProject || !hasCampaign || creating} title={!hasProject ? 'Open a project first' : !hasCampaign ? 'Launch a campaign first' : 'Agent prepares a name-matched brand account to sign up for'} onClick={create}>
              {creating ? <span className="spin">⟳</span> : '✨'} Create
            </button>
          )}
          {c.connected
            ? <button className="mini danger" onClick={() => onDisconnect(c.key)}>Disconnect</button>
            : <button className="mini" onClick={() => { setOpen(!open); setMsg(null); }}>{open ? 'Cancel' : 'Connect'}</button>}
        </div>
      </div>
      {auto && (
        <label className="chan-gen">
          <input type="checkbox" checked={!c.excluded} onChange={(e) => onExclude(c.key, !e.target.checked)} />
          Generate actions for this channel
          {c.excluded && <span className="excluded-tag">excluded — swarm skips it</span>}
        </label>
      )}
      {c.key === 'meta_ads' && c.connected && c.meta && onMetaSelect && <MetaConfig meta={c.meta} onSelect={onMetaSelect} />}
      {createMsg && <div className="chan-msg">{createMsg}</div>}
      {open && !c.connected && (isOAuth && !webhookMode ? (
        <div className="chan-form">
          {c.key === 'mastodon' ? (
            <>
              <div className="note" style={{ fontSize: 11.5 }}>Connect your <b>existing</b> Mastodon account — no new signup, no phone. We register the app on your instance and post directly via the official API.</div>
              <input className="field" placeholder="your instance, e.g. mastodon.social" value={instance} onChange={(e) => setInstance(e.target.value)} />
              <button className="approve" onClick={() => startOAuth({ instance })} disabled={busy || !instance.trim()}>
                {busy ? <span className="spin">⟳</span> : 'Connect with Mastodon ↗'}
              </button>
            </>
          ) : (
            <>
              <div className="note" style={{ fontSize: 11.5 }}>One-time setup: create a developer app, set its <b>redirect / callback URI</b> to the value below, then paste the keys. After that it's one-click.</div>
              <div className="codeline" style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                <span style={{ wordBreak: 'break-all' }}>{redirectUri}</span>
                <button className="mini" onClick={() => navigator.clipboard?.writeText(redirectUri)}>copy</button>
              </div>
              {c.key === 'x' && <UseCaseBlock />}
              <a className="note" style={{ fontSize: 11.5 }} href={portal} target="_blank" rel="noreferrer">
                {c.key === 'x' ? 'Open X developer portal ↗ — create an app, enable OAuth 2.0 (Web App / confidential), scopes incl. tweet.write'
                  : c.key === 'linkedin' ? 'Open LinkedIn developer portal ↗ — create an app, add the “Sign In with LinkedIn using OpenID Connect” + “Share on LinkedIn” products, set the redirect URL above, then copy the Client ID/Secret from the Auth tab'
                  : c.key === 'meta_ads' ? 'Open Meta for Developers ↗ — create a Business app, add Marketing API + Facebook Login, set this redirect as a valid OAuth URI, then paste App ID/Secret. NOTE: real spend needs Business Verification + App Review for ads_management (Advanced access) + an ad account with billing.'
                  : c.key === 'google_ads' ? 'Open Google Cloud Credentials ↗ — create an OAuth client (Web app) with the redirect above and the AdWords scope. NOTE: real spend also needs a Google Ads API developer token (Basic access, applied for in the Ads API Center) + your customer id + an account with billing.'
                  : c.key === 'reddit_ads' ? 'Open Reddit apps ↗ — create a "web app" with the redirect above. NOTE: the Reddit Ads API is approval-gated — your ad account needs API access granted by Reddit.'
                  : 'Open Reddit apps ↗ — create a "web app", set the redirect URI above'}
              </a>
              <input className="field" placeholder="Client ID" value={cid} onChange={(e) => setCid(e.target.value)} />
              <input className="field" type="password" placeholder="Client Secret" value={csec} onChange={(e) => setCsec(e.target.value)} />
              {isGoogleAds && (
                <>
                  <input className="field" type="password" placeholder="Developer token" value={gDevToken} onChange={(e) => setGDevToken(e.target.value)} />
                  <input className="field" placeholder="Customer ID — the ad account that runs ads (e.g. 123-456-7890)" value={gCustomer} onChange={(e) => setGCustomer(e.target.value)} />
                  <input className="field" placeholder="Manager (MCC) ID — optional, if the account is under a manager" value={gManager} onChange={(e) => setGManager(e.target.value)} />
                  <div className="note" style={{ fontSize: 11 }}>Using a manager account? Put the client ad account in <b>Customer ID</b> and the manager (MCC) ID in <b>Manager ID</b>. The Google account you sign in with must have access to that manager.</div>
                </>
              )}
              <button className="approve" onClick={() => startOAuth(isGoogleAds
                ? { client_id: cid.trim(), client_secret: csec.trim(), developer_token: gDevToken.trim(), customer_id: gCustomer.trim(), login_customer_id: gManager.trim() }
                : { client_id: cid.trim(), client_secret: csec.trim() })} disabled={busy || !cid.trim() || !csec.trim() || (isGoogleAds && (!gDevToken.trim() || !gCustomer.trim()))}>
                {busy ? <span className="spin">⟳</span> : `Connect with ${c.label} ↗`}
              </button>
              <button className="mini" style={{ alignSelf: 'flex-start', marginTop: 4 }} onClick={() => { setWebhookMode(true); setMsg(null); }}>Can’t make a dev app? Use a webhook (Make / Zapier / n8n) instead →</button>
            </>
          )}
          {msg && <div className="note" style={{ fontSize: 11.5 }}>{msg}</div>}
        </div>
      ) : (
        <div className="chan-form">
          {isOAuth && <button className="mini" style={{ alignSelf: 'flex-start' }} onClick={() => { setWebhookMode(false); setMsg(null); }}>← Back to direct connect (OAuth)</button>}
          <button className="mini" style={{ alignSelf: 'flex-start' }} onClick={() => setGuide(!guide)}>{guide ? '✕ Hide setup guide' : '📋 How to set up the automation (Make.com — free)'}</button>
          {guide && <WebhookGuide channel={c.key} />}
          <div className="note" style={{ fontSize: 11.5 }}>To auto-post here, paste a <b>posting webhook URL</b> from Zapier / Make / Buffer / n8n (pointed at your real account). We send a test ping and only mark it connected if it works.</div>
          <input className="field" placeholder="Posting webhook URL  (required to auto-post)" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} />
          <input className="field" placeholder="@handle / username  (optional, reference)" value={f.handle} onChange={(e) => setF({ ...f, handle: e.target.value })} />
          <input className="field" placeholder="API key / access token  (optional, reference)" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} />
          <button className="approve" onClick={save} disabled={busy || (!f.url && !f.handle && !f.token)}>
            {busy ? <span className="spin">⟳</span> : f.url.trim() ? 'Connect & test' : 'Save'}
          </button>
          {msg && <div className="note" style={{ fontSize: 11.5 }}>{msg}</div>}
        </div>
      ))}
      {msg && !open && <div className="chan-msg">{msg}</div>}
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
