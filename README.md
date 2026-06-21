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
3. **Execution phase (the swarm)** — you launch a budgeted campaign and a swarm
   of specialist agents proposes real actions to win customers:
   - **Growth strategist** sets the thesis and allocates the budget, then the
     **organic/community**, **email/outreach**, **paid ads**, and
     **influencer/creator** agents fan out concurrently.
   - Every action is **approval-gated**: agents `propose_action`; nothing is
     published or charged until you approve it in the queue.
   - **Budget is a hard ceiling.** Agents call `check_budget`; approving an action
     reserves its cost and any approval that would exceed the cap is blocked. At
     **$0** the swarm goes pure-organic and hunts for free ad credits.
   - **Ethical guardrails** (enforced in every agent prompt): no spam, fake
     accounts/engagement/reviews, astroturfing, ToS-violating bots, deceptive
     claims, or purchased lists. Email carries an opt-out (CAN-SPAM/GDPR).

### Channels & execution

Approved actions execute via the best connected **connector**:

| Executor | What it does |
|----------|--------------|
| **Automation webhook** | POSTs the action to your Zapier / Make / n8n / Buffer hook — the universal bridge to publish anywhere. |
| **Email (SMTP)** | Really sends approved outreach/lifecycle email (opt-out footer added). |
| **Manual / publish-ready** | No connector for that channel yet → the action is marked ready with copy-paste content. Nothing is faked as "posted". |

Manage connections from the **⚙ Channels** button (top bar). The app never
fabricates platform access — connect accounts and the same approved action that
was "publish-ready" starts auto-executing.

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
| `app/page.tsx` | The single-page UI: search box, live job feed, history, campaign panel, modals |
| `app/api/*` | REST + SSE endpoints (projects, jobs, actions, connectors, campaign) |
| `lib/db.ts` | SQLite schema + queries + budget ledger + change-signature |
| `lib/orchestrator.ts` | Job lifecycle, pause/resume, phase transitions, campaign launch, approve/execute |
| `lib/agent.ts` | Agent SDK runner + custom tools + research/marketing/execution prompts |
| `lib/connectors.ts` | Channel catalog + execution adapters (webhook / SMTP / manual) |
| `lib/pdf.ts` | PDF report rendering (pdfkit) |
