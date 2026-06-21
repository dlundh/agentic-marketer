# Agentic Marketer

A single-page agentic marketing service. Describe a product (URL, text, and/or
attached files) and autonomous Claude agents scour the web to understand it,
identify the perfect customer and target market, deliver research as downloadable
PDFs, and then run active marketing — building a go-to-market plan and ready-to-use
content. All activity streams live; every job is pausable and resumable, even
after a page reload or a full server restart.

## How it works

```
Browser (single page, SSE live feed)
        │  POST /api/projects (prompt + url + attachments)
        ▼
Next.js API routes ──► orchestrator ──► Claude Agent SDK (query loop)
        │                   │                 │  WebSearch / WebFetch / Read
        │                   │                 │  + custom tools:
        │                   │                 │    save_finding, create_pdf_report,
        │                   │                 │    mark_research_complete, mark_marketing_complete
        ▼                   ▼                 ▼
   node:sqlite  ◄────────  findings / activity / files / jobs   ──►  PDFs (pdfkit) on disk
```

1. **Research phase** — an agent studies the product, competitors, the ideal
   customer and the target market, saving findings as it goes and producing a
   *Market & Audience Analysis* PDF. When confident, it calls
   `mark_research_complete`.
2. **Marketing phase** — a second agent automatically starts, designing the best
   approach for that customer and producing a *Go-To-Market & Marketing Plan*
   (and a content pack) as PDFs.

## Authentication (your Claude subscription)

The app uses the **Claude Agent SDK**, which runs on your Claude subscription via
the `claude` CLI. The **Connect** button (top-right) detects your logged-in
session and offers a **Test connection** probe. If needed, generate a token with:

```bash
claude setup-token
```

and paste it in the Connect dialog (stored only in the running process). An
`sk-ant-…` API key is also accepted (pay-per-token). Precedence: `ANTHROPIC_API_KEY`
> `CLAUDE_CODE_OAUTH_TOKEN` > logged-in session.

Optional: set `AGENT_MODEL` to pin a model (defaults to your Claude Code default).

## Run

```bash
npm install
npm run dev      # http://localhost:4400
# or: npm run build && npm start
```

## Persistence & resilience

- All state lives in `./data/marketer.db` (SQLite, via Node's built-in
  `node:sqlite`) plus generated files under `./data/`. History survives reloads
  and restarts.
- **Pause** is written to the DB; the agent loop polls its own status and stops.
- **Resume** continues the SDK session (`resume`) when available, else re-runs the
  phase using already-saved findings — no data loss.
- On restart, `reconcile()` marks any job orphaned mid-run (stale heartbeat) as
  `paused` so you can resume it. Because Next.js dev does not share module
  singletons across route bundles, live updates (SSE) and pause/resume are driven
  through the DB rather than in-memory state.

## Project layout

| Path | Purpose |
|------|---------|
| `app/page.tsx` | The single-page UI: search box, live job feed, history, modals |
| `app/api/*` | REST + SSE endpoints |
| `lib/db.ts` | SQLite schema + queries + change-signature |
| `lib/orchestrator.ts` | Job lifecycle, pause/resume, research→marketing transition |
| `lib/agent.ts` | Agent SDK runner + custom tools + prompts |
| `lib/pdf.ts` | PDF report rendering (pdfkit) |
