# Agentic Marketer

A single-page agentic marketing service. Describe a product (URL, text, and/or
attached files) and autonomous Claude agents scour the web to understand it,
identify the perfect customer and target market, deliver research as downloadable
PDFs, and then run active marketing — building a go-to-market plan, ready-to-use
content, and (when you allow it) **fully autonomous publishing and ad spend**.
All activity streams live; every job is pausable and resumable, even after a page
reload or a full server restart.

> **Open source (MIT).** Self-hosted and local-first: all data, including the
> OAuth tokens for any accounts you connect, lives in a SQLite file on your own
> machine (`./data/marketer.db`, git-ignored). The app never holds funds — ad
> spend happens on *your* connected ad accounts where your own billing is on file.

## Highlights

- **Three phases, hands-off**: research → go-to-market plan → an execution swarm
  that proposes (or autonomously runs) real marketing actions.
- **Competitive advantage analysis**: a dedicated agent tears down how the top
  competitors market (SEO, paid ads, social, positioning) into its own PDF, and
  feeds the gaps into the marketing. Re-runnable for N more competitors anytime.
- **Per-project channel connections**: each product you market has its own set of
  connected accounts. Switch between products and posts/ads route to the right
  accounts — connections are never shared across projects.
- **Fully automated marketing** (opt-in master switch): organic posts are
  smart-scheduled at the best time per channel and auto-published; paid ads
  auto-launch, and the optimizer evaluates performance and pauses losers — all
  inside hard budget caps + a kill switch. The content pipeline refills itself.
- **Native posting** to X, LinkedIn, Reddit, and Mastodon via official OAuth; an
  automation-webhook bridge for everything else.
- **Autonomous ad spend across Meta, Google & Reddit** (one shared provider
  layer) with a total cap, daily cap, kill switch, an optimizer that pauses
  losers, and per-ad pause/resume/remove — polled in the background so spend
  stays in bounds.
- **Email outreach** with named recipient lists, CSV import, a per-project
  suppression/unsubscribe set, and `{{first_name}}`/`{{company}}` merge tokens.
- **Steer it in plain English**: a project-level *Direction & ideas* box shapes
  the whole approach; per-action *Revise* chat refines any single piece.
- **Ethical guardrails** baked into every prompt: no spam, fake accounts/
  engagement/reviews, astroturfing, bot armies, or purchased lists.

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
   - **Competitive advantage analysis** — when research completes, a dedicated
     agent automatically analyzes the top competitors and how each one actually
     markets (SEO, paid ads, organic social, positioning, pricing, strengths &
     gaps), then produces a separate *Competitive Advantage Analysis* PDF with a
     "How We Win" section. Those findings are injected into the execution swarm's
     prompts so the marketing actively exploits competitors' gaps. You can
     **re-run it anytime** and choose how many *additional* competitors to
     analyze — already-covered ones are excluded automatically.
2. **Marketing phase** — a second agent automatically starts, designing the best
   approach for that customer and producing a *Go-To-Market & Marketing Plan*
   (and a content pack) as PDFs.
3. **Execution phase (the swarm)** — you launch a budgeted campaign and a swarm
   of specialist agents proposes real actions to win customers:
   - **Growth strategist** sets the thesis and allocates the budget, then the
     **organic/community**, **email/outreach**, **paid ads**, and
     **influencer/creator** agents fan out concurrently.
   - By default every action is **approval-gated**: agents `propose_action`;
     nothing is published or charged until you approve it in the queue.
   - **Budget is a hard ceiling.** Agents call `check_budget`; approving an action
     reserves its cost and any approval that would exceed the cap is blocked. At
     **$0** the swarm goes pure-organic and hunts for free ad credits.
   - **Ethical guardrails** (enforced in every agent prompt): no spam, fake
     accounts/engagement/reviews, astroturfing, ToS-violating bots, deceptive
     claims, or purchased lists. Email carries an opt-out (CAN-SPAM/GDPR).

### Fully automated marketing (opt-in)

Flip the **🤖 Fully automated marketing** switch and the campaign runs itself —
no further clicks — within the rails you set:

- **Smart-scheduled organic posts.** Each channel has best-time-to-post windows
  with daily cadence caps and minimum gaps (e.g. X ~3/day, LinkedIn 1/day, Reddit
  sparingly) so feeds never get spammed. Proposed posts drip into the next free
  slots (status `scheduled`, shown with their publish time) and a background
  poller publishes each one at its slot via the normal posting path.
- **Self-refilling pipeline.** When the upcoming queue runs low and no agent is
  busy, the post-producing specialists respawn — reading your *live* connected
  channels each time — so it keeps generating and publishing indefinitely.
- **Autonomous ads.** Pending ads auto-launch, and the optimizer pulls per-ad
  CTR / clicks / impressions / spend on a schedule, auto-pausing ads that burn
  money with no traction (dead spend or sub-floor CTR after a fair test).
- **Always bounded.** The total cap, daily cap, and kill switch override
  everything; the kill switch instantly pauses live ad spend.
- **One safe exception.** Email and influencer outreach never auto-send — they
  draft and wait for a recipient list + your approval, since blasting without an
  opted-in list is the line the automation won't cross.

A live status banner shows scheduled-post count, the next publish time, live-ad
count, and whether agents are currently generating.

### Autonomous paid ads (Meta · Google · Reddit)

Paid channels share one provider abstraction ([lib/adproviders.ts](lib/adproviders.ts)),
so the budget caps, autonomy modes, spend-sync, optimizer, and per-ad controls
work identically across all of them. Connect an ad account and approved (or
auto-approved) ad actions launch real, initially-paused campaigns, then activate:

- **Meta Ads** — Marketing API (Facebook/Instagram). Single headline + creative image.
- **Google Ads** — responsive search ads (3–15 headlines, 2–4 descriptions). Needs
  a developer token + customer id.
- **Reddit Ads** — promoted link posts. Reddit's Ads API is approval-gated.

Shared behavior:

- **Fund / defund** the campaign budget; **total cap** + **daily cap** are hard
  limits enforced by a background poller that syncs real spend from each platform.
- **Autonomy modes**: approve every ad · approve the first then auto · fully
  autonomous · auto-optimize only.
- **Optimizer** pulls per-ad CTR/clicks/impressions/spend and auto-pauses ads that
  burn money with no traction (dead spend, or sub-floor CTR after a fair test).
- **Per-ad controls**: pause, resume, or remove any live ad. Removing deletes the
  underlying platform campaign; the kill switch pauses everything at once.
- Spend is always on **your** ad account with **your** billing — the app never
  holds or escrows money.

> **Live-test gate.** Meta, Google, and Reddit ad code is written to each
> platform's documented API but, like any paid integration, must be validated
> against a real, approved account. Google Ads needs an approved developer token;
> Reddit Ads needs Reddit to grant your account API access. Connect, then we
> verify the first live launch together.

### Per-project connections

Channels are connected **per project**, not globally. Each product you market
keeps its own X/LinkedIn/Reddit/Mastodon/Meta/SMTP connections, so switching
between products always posts and advertises through the correct accounts. Newly
connected or re-activated channels are picked up dynamically on the next
generation pass — no restart.

### Email lists & personalization

The **✉️ Email lists** manager keeps named recipient lists per project: import via
CSV, maintain a per-project suppression set, and handle unsubscribes automatically
(every send carries an opt-out link/footer). Outreach copy uses `{{first_name}}`,
`{{name}}`, `{{company}}`, and `{{email}}` merge tokens, personalized per recipient.

### Steering & revising

- **Direction & ideas** (project level): a chat box where you add goals, angles,
  constraints, or ideas that steer the *entire* approach — injected into research,
  marketing, execution, and revision prompts.
- **Revise** (per action): give feedback on any single proposed action and the
  agent rewrites just that piece (revision history is kept on the action).

### Channels & execution

Approved actions execute via the best connected **connector**:

| Executor | What it does |
|----------|--------------|
| **Native API (X / LinkedIn / Reddit / Mastodon)** | OAuth "Connect" — the app posts directly via the official API, auto-threading long copy and refreshing expired tokens. Mastodon self-registers (no dev portal); X, LinkedIn & Reddit need a one-time developer app (paste a client id/secret — the UI shows the exact redirect URI + portal link). Reddit posts need a target subreddit (the agent includes one, or add `r/...` to the action). No Zapier needed. |
| **Paid ads (Meta / Google / Reddit)** | OAuth "Connect" — launches real ad campaigns on your ad account, syncs spend, optimizes, and auto-pauses at caps. Meta needs Business Verification + App Review; Google needs a developer token + customer id; Reddit Ads API access is approval-gated. |
| **Email (SMTP)** | Really sends approved outreach/lifecycle email to your lists (opt-out footer + suppression enforced). |
| **Automation webhook** | POSTs the action to your Zapier / Make / n8n / Buffer hook — the universal bridge to publish anywhere. |
| **Manual / publish-ready** | No connector for that channel yet → the action is marked ready with copy-paste content. Nothing is faked as "posted". |

Connectors are only marked **connected** after verification — a posting webhook is
test-pinged, SMTP is authenticated, Mastodon completes OAuth. A bare handle/token
is saved as a note but stays publish-ready (never a fake "connected").

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
cp .env.example .env.local   # optional — every variable is optional
npm run dev                  # http://localhost:4400
# or: npm run build && npm start
```

Requires **Node 22.5+** (for the built-in `node:sqlite` module). All environment
variables are optional and documented in [.env.example](.env.example).

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
- A single background poller (guarded on `globalThis`) runs every 5 minutes
  regardless of whether the UI is open: it syncs ad spend, enforces caps, smart-
  schedules and publishes due posts, refills the content pipeline, and runs the
  ad optimizer.

## Project layout

| Path | Purpose |
|------|---------|
| `app/page.tsx` | The single-page UI: search box, live job feed, history, campaign panel, modals |
| `app/api/*` | REST + SSE endpoints (projects, jobs, actions, connectors, campaign, lists, directives, oauth) |
| `lib/db.ts` | SQLite schema + queries: projects, jobs, per-project connectors, budget ledger, scheduling, email lists, directives |
| `lib/orchestrator.ts` | Job lifecycle, pause/resume, phase transitions, campaign + budget controls, approve/execute, smart scheduler + ad optimizer |
| `lib/agent.ts` | Agent SDK runner + custom tools + research/marketing/execution/revision prompts |
| `lib/connectors.ts` | Channel catalog + execution adapters (native API / Meta ads / SMTP / webhook / manual) |
| `lib/oauth.ts` | OAuth flows for X, LinkedIn, Reddit, Mastodon (PKCE, token refresh, posting) |
| `lib/adproviders.ts` | Uniform ad-provider interface + registry (Meta / Google / Reddit) |
| `lib/meta.ts` | Meta Marketing API: OAuth, campaign/adset/creative/ad creation, insights, status |
| `lib/google.ts` | Google Ads API: OAuth + refresh, responsive-search-ad launch, insights, status |
| `lib/redditads.ts` | Reddit Ads API (v3): OAuth, campaign/ad-group/ad launch, reports, status |
| `lib/pdf.ts` | PDF report rendering (pdfkit) |

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the
pre-PR checklist, how to add a channel adapter, and the (non-negotiable) ethics
guidelines.

## License

MIT — see [LICENSE](LICENSE). This is a self-hosted, local-first tool; you are
responsible for using connected platforms within their terms of service and
applicable law (CAN-SPAM/GDPR for email, platform automation policies, ad
disclosure rules, etc.).
