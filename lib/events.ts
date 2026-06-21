import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// In-process pub/sub bridging the agent orchestrator -> SSE route -> browser.
// Kept on globalThis so HMR / multiple route modules share one bus.
// ---------------------------------------------------------------------------

export type AppEvent =
  | { type: 'project'; projectId: string }
  | { type: 'job'; projectId: string; jobId: string }
  | { type: 'activity'; projectId: string; jobId: string; activity: any }
  | { type: 'finding'; projectId: string; jobId?: string }
  | { type: 'file'; projectId: string; jobId?: string; file: any };

const g = globalThis as unknown as { __bus?: EventEmitter };
const bus = g.__bus ?? (g.__bus = new EventEmitter().setMaxListeners(0));

export function emitEvent(e: AppEvent) {
  bus.emit('event', e);
}

export function onEvent(fn: (e: AppEvent) => void) {
  bus.on('event', fn);
  return () => bus.off('event', fn);
}
