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
type Detail = { project: Project; jobs: Job[]; findings: Finding[]; files: FileRow[] };
type Auth = { connected: boolean; method: string; detail: string };

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

  const modalJob = detail?.jobs.find((j) => j.id === modalJobId) || null;

  return (
    <>
      <div className="topbar">
        <div className="brand"><span className="dot" /> Agentic Marketer</div>
        <button className={`connect ${auth?.connected ? 'on' : 'off'}`} onClick={() => setShowConnect(true)}>
          <span className="pip" />
          {auth?.connected ? 'Claude connected' : 'Connect Claude'}
        </button>
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
  const label = ({ text: 'thinking', tool_use: 'tool', finding: 'learned', file: 'file', status: 'status', error: 'error' } as any)[a.kind] || a.kind;
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
  const label = phase === 'research' ? 'Researching' : phase === 'marketing' ? 'Marketing' : 'Complete';
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
