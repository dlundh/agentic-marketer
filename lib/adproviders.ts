// ---------------------------------------------------------------------------
// Uniform ad-provider abstraction.
//
// Every paid channel (Meta / Google / Reddit) implements the same small
// interface so the orchestrator's budget caps, kill switch, autonomy modes,
// background spend-sync, and per-ad pause/resume/remove work identically across
// all of them. To add a provider: implement AdProvider in its lib module and
// register it below.
// ---------------------------------------------------------------------------

import { getConnector } from './db';
import { metaProvider } from './meta';
import { googleProvider } from './google';
import { redditAdsProvider } from './redditads';

// Platform entity ids for one launched ad (stored on the action under `meta_ids`
// for backwards-compat — the field is really "this ad's platform entity ids").
export type AdIds = { campaignId: string; adsetId?: string; adId?: string; creativeId?: string; [k: string]: any };
export type AdMetrics = { spendCents: number; impressions: number; clicks: number };

export interface AdProvider {
  key: string;
  label: string;
  launch(secrets: any, spec: import('./meta').AdSpec): Promise<AdIds>;
  setStatus(secrets: any, ids: AdIds, status: 'ACTIVE' | 'PAUSED'): Promise<void>;
  remove(secrets: any, ids: AdIds): Promise<void>;
  insights(secrets: any, ids: AdIds): Promise<AdMetrics>;
}

const PROVIDERS: Record<string, AdProvider> = {
  meta_ads: metaProvider,
  google_ads: googleProvider,
  reddit_ads: redditAdsProvider,
};

export const AD_CHANNELS = Object.keys(PROVIDERS);
export const isAdChannel = (channel: string): boolean => channel in PROVIDERS;
export const adProvider = (channel: string): AdProvider | null => PROVIDERS[channel] || null;

// Connected secrets for a project's ad channel, or null.
export function adSecrets(projectId: string, channel: string): any | null {
  const c = getConnector(projectId, channel);
  return c?.connected && c.secrets ? JSON.parse(c.secrets) : null;
}
