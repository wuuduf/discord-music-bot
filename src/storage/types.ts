import type { QueueItem, RepeatMode } from '../music/types.js';
import type { ResolvedTrack } from '../music/source-resolver.js';

export type GuildSettings = {
  guildId: string;
  volume: number;
  repeatMode: RepeatMode;
  djRoleId?: string;
};

export type QueueTerminalStatus = 'completed' | 'skipped' | 'failed' | 'removed';

export interface BotStorage {
  loadQueuedItems(): QueueItem[];
  saveQueueItem(item: QueueItem, position: number): void;
  markQueueItemPlaying(requestId: string): void;
  markQueueItemFinished(requestId: string, status: QueueTerminalStatus): void;
  clearGuildQueue(guildId: string): void;
  getGuildSettings(guildId: string): GuildSettings;
  upsertGuildSettings(settings: GuildSettings): void;
  upsertTrackCache(track: ResolvedTrack, ttlMs?: number): void;
  close(): void;
}
