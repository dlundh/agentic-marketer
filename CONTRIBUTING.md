# Contributing to Agentic Marketer

Thanks for your interest! This is a self-hosted, local-first app. Contributions
of all kinds are welcome — bug reports, features, channel adapters, docs.

## Getting started

```bash
git clone https://github.com/dlundh/agentic-marketer.git
cd agentic-marketer
npm install
cp .env.example .env.local   # optional — all vars are optional (see the file)
npm run dev                  # http://localhost:4400
```

You need **Node 22.5+** (the app uses the built-in `node:sqlite` module) and either
a logged-in `claude` CLI session, a `CLAUDE_CODE_OAUTH_TOKEN`, or an
`ANTHROPIC_API_KEY`. See [.env.example](.env.example) and the README's
*Authentication* section.

State lives in `./data/marketer.db` (git-ignored). Delete that file to reset.

## Before opening a PR

- **Type-check passes:** `npx tsc --noEmit` (the `globals.css` side-effect import
  warning is expected and harmless).
- **It builds:** `npm run build`.
- Keep changes focused; match the surrounding code style (comment density,
  naming, idioms). Many modules carry a header comment explaining intent — update
  it if you change the behavior it describes.
- Don't commit secrets, tokens, or anything from `./data/`. The repo is configured
  to ignore `.env*.local`, `data/`, and build output — keep it that way.

## Architecture at a glance

| Path | Purpose |
|------|---------|
| `app/page.tsx` | Single-page UI |
| `app/api/*` | REST + SSE endpoints |
| `lib/db.ts` | SQLite schema + queries (per-project connectors, budget ledger, scheduling, lists) |
| `lib/orchestrator.ts` | Job lifecycle, campaign/budget controls, smart scheduler + ad optimizer |
| `lib/agent.ts` | Agent SDK runner, custom tools, prompts |
| `lib/connectors.ts` | Channel catalog + execution adapters |
| `lib/oauth.ts` / `lib/meta.ts` | OAuth + posting (X/LinkedIn/Reddit/Mastodon) / Meta Marketing API |

A few conventions worth knowing:

- **Per-project everything.** Connectors and campaigns are keyed by `project_id`;
  never reintroduce global channel state.
- **Background work** runs from a single `globalThis`-guarded poller in
  `lib/orchestrator.ts`. Add periodic behavior there, not in new intervals.
- **State over memory.** Next.js dev doesn't share module singletons across route
  bundles, so live updates and pause/resume go through the DB, not in-process state.

## Adding a channel adapter

1. Add the channel to the `CHANNELS` catalog in `lib/connectors.ts`.
2. Implement its executor (native API in `lib/oauth.ts`, or reuse webhook/SMTP).
3. For OAuth channels, wire `start`/`callback` in `app/api/oauth/[provider]/`.
4. If it auto-publishes, make sure `isAutoExecutable` and the scheduler's
   `isAutoPostable` treat it correctly.

## Ethics & safety (non-negotiable)

This project deliberately refuses to enable abuse. Please **do not** contribute
features for: fake-account creation, fake engagement/reviews, astroturfing,
spam/unsolicited-list email, bot armies, or detection evasion. Autonomous ad spend
must always keep the hard total cap, daily cap, and kill switch. The app must
never hold or escrow funds — spend happens on the user's own connected accounts.

## License

By contributing, you agree your contributions are licensed under the project's
[MIT License](LICENSE).
