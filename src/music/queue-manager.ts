import { randomUUID } from 'node:crypto';
import type { BotStorage } from '../storage/types.js';
import type { ResolvedTrack } from './source-resolver.js';
import type { GuildQueue, QueueItem, RepeatMode, TrackSource } from './types.js';

export class QueueLimitError extends Error {
  constructor(public readonly maxQueueSize: number) {
    super(`Guild queue limit reached: ${maxQueueSize}`);
  }
}

export type EnqueueInput = {
  guildId: string;
  textChannelId: string;
  voiceChannelId?: string;
  requestedBy: string;
  title: string;
  artist?: string;
  source?: TrackSource;
  sourceUrl: string;
  playableUrl?: string;
  artworkUrl?: string;
  durationMs?: number;
};

export type QueueStats = {
  queued: number;
  current: boolean;
  volume: number;
  repeatMode: RepeatMode;
  maxQueueSize: number;
  djRoleId?: string;
};

export class QueueManager {
  private readonly queues = new Map<string, GuildQueue>();

  constructor(private readonly storage?: BotStorage, private readonly maxQueueSize = 50) {
    if (this.storage) {
      this.restoreQueuedItems(this.storage.loadQueuedItems());
    }
  }

  getQueue(guildId: string): GuildQueue {
    const existing = this.queues.get(guildId);
    if (existing) return existing;

    const settings = this.storage?.getGuildSettings(guildId);
    const created: GuildQueue = {
      guildId,
      items: [],
      volume: settings?.volume ?? 80,
      repeatMode: settings?.repeatMode ?? 'off',
      djRoleId: settings?.djRoleId
    };
    this.queues.set(guildId, created);
    return created;
  }

  enqueue(input: EnqueueInput): QueueItem {
    const queue = this.getQueue(input.guildId);
    this.assertQueueCapacity(queue);
    const item: QueueItem = {
      requestId: randomUUID(),
      guildId: input.guildId,
      textChannelId: input.textChannelId,
      voiceChannelId: input.voiceChannelId,
      requestedBy: input.requestedBy,
      title: input.title,
      artist: input.artist,
      source: input.source ?? 'test',
      sourceUrl: input.sourceUrl,
      playableUrl: input.playableUrl,
      artworkUrl: input.artworkUrl,
      durationMs: input.durationMs,
      createdAt: new Date()
    };
    this.pushQueuedItem(queue, item);
    return item;
  }

  enqueueResolved(input: Omit<EnqueueInput, 'title' | 'sourceUrl'> & { track: ResolvedTrack }): QueueItem {
    return this.enqueue({
      ...input,
      title: formatResolvedTrackTitle(input.track),
      artist: input.track.artist,
      source: input.track.source,
      sourceUrl: input.track.sourceUrl,
      playableUrl: input.track.playableUrl,
      artworkUrl: input.track.artworkUrl,
      durationMs: input.track.durationMs
    });
  }

  next(guildId: string): QueueItem | undefined {
    const queue = this.getQueue(guildId);
    if (queue.current) {
      const previous = queue.current;
      if (queue.repeatMode === 'one') {
        this.storage?.markQueueItemPlaying(previous.requestId);
        return previous;
      }

      this.storage?.markQueueItemFinished(previous.requestId, 'completed');
      if (queue.repeatMode === 'all') {
        const repeated = cloneQueueItem(previous);
        if (queue.items.length < this.maxQueueSize) {
          this.pushQueuedItem(queue, repeated);
        }
      }
    }

    queue.current = queue.items.shift();
    if (queue.current) {
      this.storage?.markQueueItemPlaying(queue.current.requestId);
      this.persistQueuePositions(queue);
    }
    return queue.current;
  }

  finishCurrent(guildId: string): void {
    const queue = this.getQueue(guildId);
    if (queue.current) {
      this.storage?.markQueueItemFinished(queue.current.requestId, 'completed');
    }
    queue.current = undefined;
  }

  markCurrentSkipped(guildId: string): void {
    const queue = this.getQueue(guildId);
    if (queue.current) {
      this.storage?.markQueueItemFinished(queue.current.requestId, 'skipped');
      queue.current = undefined;
    }
  }

  markCurrentFailed(guildId: string): void {
    const queue = this.getQueue(guildId);
    if (queue.current) {
      this.storage?.markQueueItemFinished(queue.current.requestId, 'failed');
      queue.current = undefined;
    }
  }

  remove(guildId: string, oneBasedPosition: number): QueueItem | undefined {
    const queue = this.getQueue(guildId);
    const index = oneBasedPosition - 1;
    if (!Number.isInteger(index) || index < 0 || index >= queue.items.length) {
      return undefined;
    }

    const [removed] = queue.items.splice(index, 1);
    if (removed) {
      this.storage?.markQueueItemFinished(removed.requestId, 'removed');
      this.persistQueuePositions(queue);
    }
    return removed;
  }

  shuffle(guildId: string): number {
    const queue = this.getQueue(guildId);
    for (let i = queue.items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [queue.items[i], queue.items[j]] = [queue.items[j], queue.items[i]];
    }
    this.persistQueuePositions(queue);
    return queue.items.length;
  }

  nowPlaying(guildId: string): QueueItem | undefined {
    return this.getQueue(guildId).current;
  }

  setVolume(guildId: string, volume: number): number {
    const normalized = clampVolume(volume);
    const queue = this.getQueue(guildId);
    queue.volume = normalized;
    this.persistGuildSettings(queue);
    return normalized;
  }

  setRepeatMode(guildId: string, repeatMode: RepeatMode): RepeatMode {
    const queue = this.getQueue(guildId);
    queue.repeatMode = normalizeRepeatMode(repeatMode);
    this.persistGuildSettings(queue);
    return queue.repeatMode;
  }

  setDjRoleId(guildId: string, roleId: string | undefined): string | undefined {
    const queue = this.getQueue(guildId);
    queue.djRoleId = roleId;
    this.persistGuildSettings(queue);
    return queue.djRoleId;
  }

  stats(guildId: string): QueueStats {
    const queue = this.getQueue(guildId);
    return {
      queued: queue.items.length,
      current: Boolean(queue.current),
      volume: queue.volume,
      repeatMode: queue.repeatMode,
      maxQueueSize: this.maxQueueSize,
      djRoleId: queue.djRoleId
    };
  }

  clear(guildId: string): void {
    const queue = this.getQueue(guildId);
    queue.items = [];
    queue.current = undefined;
    this.storage?.clearGuildQueue(guildId);
  }

  private assertQueueCapacity(queue: GuildQueue): void {
    if (queue.items.length >= this.maxQueueSize) {
      throw new QueueLimitError(this.maxQueueSize);
    }
  }

  private pushQueuedItem(queue: GuildQueue, item: QueueItem): void {
    queue.items.push(item);
    this.storage?.saveQueueItem(item, queue.items.length);
  }

  private persistQueuePositions(queue: GuildQueue): void {
    queue.items.forEach((item, index) => this.storage?.saveQueueItem(item, index + 1));
  }

  private persistGuildSettings(queue: GuildQueue): void {
    this.storage?.upsertGuildSettings({
      guildId: queue.guildId,
      volume: queue.volume,
      repeatMode: queue.repeatMode,
      djRoleId: queue.djRoleId
    });
  }

  private restoreQueuedItems(items: QueueItem[]): void {
    for (const item of items) {
      const queue = this.getQueue(item.guildId);
      if (queue.items.length < this.maxQueueSize) {
        queue.items.push(item);
      }
    }
  }
}

function cloneQueueItem(item: QueueItem): QueueItem {
  return {
    ...item,
    requestId: randomUUID(),
    createdAt: new Date()
  };
}

function formatResolvedTrackTitle(track: ResolvedTrack): string {
  if (track.artist) {
    return `${track.artist} - ${track.title}`;
  }
  return track.title;
}

function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return 80;
  return Math.min(Math.max(Math.trunc(value), 0), 100);
}

function normalizeRepeatMode(value: RepeatMode): RepeatMode {
  if (value === 'one' || value === 'all') return value;
  return 'off';
}
