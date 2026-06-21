import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Detect how the Agent SDK will authenticate. The SDK spawns the `claude`
// binary, which inherits this process's env, so a token set at runtime via the
// Connect button is honoured by every subsequent job.
// ---------------------------------------------------------------------------

export type AuthStatus = {
  connected: boolean;
  method: 'api_key' | 'oauth_token' | 'subscription' | 'none';
  detail: string;
};

export function detectAuth(): AuthStatus {
  if (process.env.ANTHROPIC_API_KEY) {
    return { connected: true, method: 'api_key', detail: 'Using ANTHROPIC_API_KEY (pay-per-token, billed separately from your subscription).' };
  }
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { connected: true, method: 'oauth_token', detail: 'Using a Claude subscription OAuth token.' };
  }
  // Logged-in Claude Code session credentials on disk.
  const home = homedir();
  const credFiles = [
    path.join(home, '.claude', '.credentials.json'),
    path.join(home, '.config', 'claude', '.credentials.json'),
  ];
  if (credFiles.some((f) => existsSync(f))) {
    return { connected: true, method: 'subscription', detail: 'Using your logged-in Claude Code subscription session.' };
  }
  // On macOS the session may live in the Keychain (set up by Claude Code login).
  // We can't read that without risking a prompt, so report "likely" only if the
  // claude config dir exists.
  if (existsSync(path.join(home, '.claude.json')) || existsSync(path.join(home, '.claude'))) {
    return { connected: true, method: 'subscription', detail: 'A Claude Code session was found. Use "Test connection" to confirm it works.' };
  }
  return { connected: false, method: 'none', detail: 'No Claude credentials detected. Connect your subscription to begin.' };
}

// Accept a token from the Connect UI and apply it to this process so the SDK
// (and the claude subprocesses it spawns) pick it up immediately.
export function applyToken(token: string) {
  const t = token.trim();
  if (!t) return;
  if (t.startsWith('sk-ant-')) {
    process.env.ANTHROPIC_API_KEY = t;
  } else {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = t;
  }
}
