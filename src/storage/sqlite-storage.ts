import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Logger } from 'pino';
import type { ResolvedTrack } from '../music/source-resolver.js';
import type { QueueItem, TrackSource } from '../music/types.js';
import type { BotStorage, GuildSettings, QueueTerminalStatus } from './types.js';

type QueueItemRow = {
  id: string;
  guild_id: string;
  text_channel_id: string;
  voice_channel_id: string | null;
  requested_by: string;
  title: string;
  artist: string | null;
  source: string;
  source_url: string;
  playable_url: string | null;
  artwork_url: string | null;
  duration_ms: number | null;
  created_at: string;
};

type GuildSettingsRow = {
  guild_id: string;
  volume: number;
  repeat_mode: string;
  dj_role_id: string | null;
};

export class SqliteStorage implements BotStorage {
  private readonly db: DatabaseSync;

  constructor(storagePath: string, private readonly logger: Logger) {
    const resolvedPath = resolve(storagePath);
    mkdirSync(dirname(resolvedPath), { recursive: true });
    this.db = new DatabaseSync(resolvedPath, { timeout: 5_000 });
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
    const stale = this.db.prepare(`
      UPDATE queue_items
      SET status = 'queued', updated_at = datetime('now')
      WHERE status = 'playing'
    `).run();
    if (stale.changes > 0) {
      this.logger.warn({ count: stale.changes }, 'reset stale playing queue items to queued');
    }
    this.logger.info({ path: resolvedPath }, 'sqlite storage ready');
  }

  loadQueuedItems(): QueueItem[] {
    const rows = this.db.prepare(`
      SELECT id, guild_id, text_channel_id, voice_channel_id, requested_by, title, artist,
             source, source_url, playable_url, artwork_url, duration_ms, created_at
      FROM queue_items
      WHERE status = 'queued'
      ORDER BY guild_id ASC, position ASC, created_at ASC
    `).all() as QueueItemRow[];

    return rows.map(rowToQueueItem);
  }

  saveQueueItem(item: QueueItem, position: number): void {
    this.ensureGuildSettings(item.guildId);
    this.db.prepare(`
      INSERT INTO queue_items (
        id, guild_id, text_channel_id, voice_channel_id, requested_by, title, artist,
        source, source_url, playable_url, artwork_url, duration_ms, position, status,
        created_at, updated_at
      )
      VALUES (
        :id, :guildId, :textChannelId, :voiceChannelId, :requestedBy, :title, :artist,
        :source, :sourceUrl, :playableUrl, :artworkUrl, :durationMs, :position, 'queued',
        :createdAt, datetime('now')
      )
      ON CONFLICT(id) DO UPDATE SET
        guild_id = excluded.guild_id,
        text_channel_id = excluded.text_channel_id,
        voice_channel_id = excluded.voice_channel_id,
        requested_by = excluded.requested_by,
        title = excluded.title,
        artist = excluded.artist,
        source = excluded.source,
        source_url = excluded.source_url,
        playable_url = excluded.playable_url,
        artwork_url = excluded.artwork_url,
        duration_ms = excluded.duration_ms,
        position = excluded.position,
        status = 'queued',
        updated_at = datetime('now')
    `).run({
      id: item.requestId,
      guildId: item.guildId,
      textChannelId: item.textChannelId,
      voiceChannelId: item.voiceChannelId ?? null,
      requestedBy: item.requestedBy,
      title: item.title,
      artist: item.artist ?? null,
      source: item.source,
      sourceUrl: item.sourceUrl,
      playableUrl: item.playableUrl ?? null,
      artworkUrl: item.artworkUrl ?? null,
      durationMs: item.durationMs ?? null,
      position,
      createdAt: item.createdAt.toISOString()
    });
  }

  markQueueItemPlaying(requestId: string): void {
    this.db.prepare(`
      UPDATE queue_items
      SET status = 'playing', updated_at = datetime('now')
      WHERE id = :id
    `).run({ id: requestId });
  }

  markQueueItemFinished(requestId: string, status: QueueTerminalStatus): void {
    this.db.prepare(`
      UPDATE queue_items
      SET status = :status, updated_at = datetime('now')
      WHERE id = :id
    `).run({ id: requestId, status });
  }

  clearGuildQueue(guildId: string): void {
    this.db.prepare(`
      UPDATE queue_items
      SET status = 'cleared', updated_at = datetime('now')
      WHERE guild_id = :guildId AND status IN ('queued', 'playing')
    `).run({ guildId });
  }

  getGuildSettings(guildId: string): GuildSettings {
    this.ensureGuildSettings(guildId);
    const row = this.db.prepare(`
      SELECT guild_id, volume, repeat_mode, dj_role_id
      FROM guild_settings
      WHERE guild_id = :guildId
    `).get({ guildId }) as GuildSettingsRow | undefined;

    return {
      guildId,
      volume: clampVolume(row?.volume ?? 80),
      repeatMode: normalizeRepeatMode(row?.repeat_mode),
      djRoleId: row?.dj_role_id ?? undefined
    };
  }

  upsertGuildSettings(settings: GuildSettings): void {
    this.db.prepare(`
      INSERT INTO guild_settings (guild_id, volume, repeat_mode, dj_role_id, updated_at)
      VALUES (:guildId, :volume, :repeatMode, :djRoleId, datetime('now'))
      ON CONFLICT(guild_id) DO UPDATE SET
        volume = excluded.volume,
        repeat_mode = excluded.repeat_mode,
        dj_role_id = excluded.dj_role_id,
        updated_at = datetime('now')
    `).run({
      guildId: settings.guildId,
      volume: clampVolume(settings.volume),
      repeatMode: normalizeRepeatMode(settings.repeatMode),
      djRoleId: settings.djRoleId ?? null
    });
  }

  upsertTrackCache(track: ResolvedTrack, ttlMs = 24 * 60 * 60 * 1000): void {
    const cacheKey = `${track.source}:${track.id}`;
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    this.db.prepare(`
      INSERT INTO track_cache (
        cache_key, source, source_id, title, artist, album, source_url, playable_url,
        artwork_url, duration_ms, expires_at, updated_at
      )
      VALUES (
        :cacheKey, :source, :sourceId, :title, :artist, :album, :sourceUrl, :playableUrl,
        :artworkUrl, :durationMs, :expiresAt, datetime('now')
      )
      ON CONFLICT(cache_key) DO UPDATE SET
        title = excluded.title,
        artist = excluded.artist,
        album = excluded.album,
        source_url = excluded.source_url,
        playable_url = excluded.playable_url,
        artwork_url = excluded.artwork_url,
        duration_ms = excluded.duration_ms,
        expires_at = excluded.expires_at,
        updated_at = datetime('now')
    `).run({
      cacheKey,
      source: track.source,
      sourceId: track.id,
      title: track.title,
      artist: track.artist ?? null,
      album: track.album ?? null,
      sourceUrl: track.sourceUrl,
      playableUrl: track.playableUrl ?? null,
      artworkUrl: track.artworkUrl ?? null,
      durationMs: track.durationMs ?? null,
      expiresAt
    });
  }

  close(): void {
    this.db.close();
  }

  private ensureGuildSettings(guildId: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO guild_settings (guild_id, volume, repeat_mode, dj_role_id, updated_at)
      VALUES (:guildId, 80, 'off', NULL, datetime('now'))
    `).run({ guildId });
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS guild_settings (
        guild_id TEXT PRIMARY KEY,
        volume INTEGER NOT NULL DEFAULT 80,
        repeat_mode TEXT NOT NULL DEFAULT 'off',
        dj_role_id TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS queue_items (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        text_channel_id TEXT NOT NULL,
        voice_channel_id TEXT,
        requested_by TEXT NOT NULL,
        title TEXT NOT NULL,
        artist TEXT,
        source TEXT NOT NULL,
        source_url TEXT NOT NULL,
        playable_url TEXT,
        artwork_url TEXT,
        duration_ms INTEGER,
        position INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_queue_items_guild_status_position
        ON queue_items (guild_id, status, position, created_at);

      CREATE TABLE IF NOT EXISTS track_cache (
        cache_key TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        source_id TEXT NOT NULL,
        title TEXT NOT NULL,
        artist TEXT,
        album TEXT,
        source_url TEXT NOT NULL,
        playable_url TEXT,
        artwork_url TEXT,
        duration_ms INTEGER,
        expires_at TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_track_cache_source
        ON track_cache (source, source_id);
    `);
    this.addColumnIfMissing('guild_settings', 'dj_role_id', 'TEXT');
  }

  private addColumnIfMissing(tableName: string, columnName: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === columnName)) {
      this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    }
  }
}

function rowToQueueItem(row: QueueItemRow): QueueItem {
  return {
    requestId: row.id,
    guildId: row.guild_id,
    textChannelId: row.text_channel_id,
    voiceChannelId: row.voice_channel_id ?? undefined,
    requestedBy: row.requested_by,
    title: row.title,
    artist: row.artist ?? undefined,
    source: normalizeTrackSource(row.source),
    sourceUrl: row.source_url,
    playableUrl: row.playable_url ?? undefined,
    artworkUrl: row.artwork_url ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    createdAt: new Date(row.created_at)
  };
}

function normalizeTrackSource(value: string): TrackSource {
  if (value === 'apple_music' || value === 'url' || value === 'test') {
    return value;
  }
  return 'test';
}

function normalizeRepeatMode(value: unknown): GuildSettings['repeatMode'] {
  if (value === 'one' || value === 'all') {
    return value;
  }
  return 'off';
}

function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return 80;
  return Math.min(Math.max(Math.trunc(value), 0), 100);
}
