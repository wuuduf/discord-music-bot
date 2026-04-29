import { LavalinkManager, type RepeatMode as LavalinkRepeatMode, type SearchPlatform, type Track } from 'lavalink-client';
import type { Client, User, VoiceBasedChannel } from 'discord.js';
import type { Logger } from 'pino';
import type { RepeatMode } from './types.js';

export type LavalinkServiceConfig = {
  enabled: boolean;
  host: string;
  port: number;
  password: string;
  secure: boolean;
  searchSource: SearchPlatform;
  fallbackSearchSource?: SearchPlatform;
};

export type LavalinkPlayResult = {
  title: string;
  added: number;
  playlistName?: string;
};

type PlaybackFallbackContext = {
  originalQuery: string;
  fallbackQuery: string;
  primarySource: string;
  fallbackSource: SearchPlatform;
  textChannelId: string;
  requester: unknown;
  createdAt: number;
  attempted: boolean;
};

const fallbackContextTtlMs = 30 * 60 * 1000;

export class LavalinkService {
  readonly manager?: LavalinkManager;
  private readonly fallbackByTrackKey = new Map<string, PlaybackFallbackContext>();
  private readonly fallbackInFlightGuilds = new Set<string>();

  constructor(
    private readonly client: Client,
    private readonly config: LavalinkServiceConfig,
    private readonly logger: Logger
  ) {
    if (!config.enabled) return;

    this.manager = new LavalinkManager({
      nodes: [
        {
          id: 'main',
          host: config.host,
          port: config.port,
          authorization: config.password,
          secure: config.secure
        }
      ],
      sendToShard: (guildId, payload) => this.client.guilds.cache.get(guildId)?.shard?.send(payload),
      autoSkip: true,
      client: {
        id: process.env.DISCORD_CLIENT_ID ?? '0',
        username: 'Discord Music Bot'
      },
      playerOptions: {
        defaultSearchPlatform: config.searchSource,
        onDisconnect: {
          autoReconnect: true,
          destroyPlayer: false
        },
        onEmptyQueue: {
          destroyAfterMs: 30_000
        },
        useUnresolvedData: true
      }
    });

    this.manager.nodeManager.on('connect', node => this.logger.info({ node: node.id }, 'lavalink node connected'));
    this.manager.nodeManager.on('disconnect', (node, reason) => this.logger.warn({ node: node.id, reason }, 'lavalink node disconnected'));
    this.manager.nodeManager.on('error', (node, error) => this.logger.error({ node: node.id, err: error }, 'lavalink node error'));
    this.manager.on('trackError', (player, track, payload) => {
      void this.handlePlaybackFailure(player as any, track as any, payload, 'trackError');
    });
    this.manager.on('trackStuck', (player, track, payload) => {
      void this.handlePlaybackFailure(player as any, track as any, payload, 'trackStuck');
    });
    this.manager.on('trackEnd', (_player, track, payload) => {
      if (payload.reason !== 'loadFailed') this.deleteFallbackContext(track as any);
    });
  }

  get enabled(): boolean {
    return Boolean(this.manager);
  }

  async init(user: User): Promise<void> {
    if (!this.manager || this.manager.initiated) return;
    await this.manager.init({ id: user.id, username: user.username });
  }

  async sendRawData(payload: unknown): Promise<void> {
    await this.manager?.sendRawData(payload as any);
  }

  async play(voiceChannel: VoiceBasedChannel, textChannelId: string, query: string, requester: unknown): Promise<LavalinkPlayResult> {
    if (!this.manager?.useable) {
      throw new Error('Lavalink node is not connected yet');
    }

    const player = this.getOrCreatePlayer(voiceChannel, textChannelId);
    await player.connect();

    const directUrl = isHttpUrl(query);
    const primarySource = directUrl ? undefined : this.config.searchSource;
    const searchQuery = directUrl
      ? { query }
      : { query, source: primarySource };
    const result = await player.search(searchQuery, requester, false) as any;
    const tracks = Array.isArray(result.tracks) ? result.tracks : [];
    if (tracks.length === 0) {
      throw new Error(`No Lavalink tracks found for query: ${query}`);
    }

    const toAdd = result.loadType === 'playlist' ? tracks : [tracks[0]];
    if (!directUrl && primarySource && this.shouldFallbackFrom(primarySource)) {
      this.registerFallbackContexts(toAdd, {
        originalQuery: query,
        primarySource: String(primarySource),
        fallbackSource: this.config.fallbackSearchSource ?? 'scsearch',
        textChannelId,
        requester
      });
    }

    await player.queue.add(toAdd);
    if (!player.playing && !player.paused) {
      await player.play();
    }

    return {
      title: formatTrack(toAdd[0]),
      added: toAdd.length,
      playlistName: result.playlist?.title ?? result.playlist?.name
    };
  }

  async pause(guildId: string): Promise<boolean> {
    const player = this.manager?.getPlayer(guildId);
    if (!player || !player.playing || player.paused) return false;
    await player.pause();
    return true;
  }

  async resume(guildId: string): Promise<boolean> {
    const player = this.manager?.getPlayer(guildId);
    if (!player || !player.paused) return false;
    await player.resume();
    return true;
  }

  async skip(guildId: string): Promise<boolean> {
    const player = this.manager?.getPlayer(guildId);
    if (!player || !player.queue.current) return false;
    await player.skip();
    return true;
  }

  async stop(guildId: string): Promise<boolean> {
    const player = this.manager?.getPlayer(guildId);
    if (!player) return false;
    await player.destroy('stopped by command', true);
    return true;
  }

  async clear(guildId: string): Promise<number> {
    const player = this.manager?.getPlayer(guildId);
    if (!player) return 0;
    const count = player.queue.tracks.length;
    await player.queue.splice(0, count);
    return count;
  }

  async remove(guildId: string, oneBasedPosition: number): Promise<string | undefined> {
    const player = this.manager?.getPlayer(guildId);
    if (!player) return undefined;
    const index = oneBasedPosition - 1;
    const target = player.queue.tracks[index];
    if (!target) return undefined;
    await player.queue.remove(index);
    return formatTrack(target);
  }

  async shuffle(guildId: string): Promise<number> {
    const player = this.manager?.getPlayer(guildId);
    if (!player) return 0;
    return await player.queue.shuffle();
  }

  async setVolume(guildId: string, volume: number): Promise<number> {
    const player = this.manager?.getPlayer(guildId);
    const normalized = Math.max(0, Math.min(100, volume));
    if (!player) return normalized;
    await player.setVolume(normalized);
    return player.volume;
  }

  async setRepeatMode(guildId: string, repeatMode: RepeatMode): Promise<RepeatMode> {
    const player = this.manager?.getPlayer(guildId);
    if (!player) return repeatMode;
    await player.setRepeatMode(toLavalinkRepeatMode(repeatMode));
    return fromLavalinkRepeatMode(player.repeatMode);
  }

  nowPlaying(guildId: string): string | undefined {
    const current = this.manager?.getPlayer(guildId)?.queue.current;
    return current ? formatTrack(current) : undefined;
  }

  queueText(guildId: string): string {
    const player = this.manager?.getPlayer(guildId);
    if (!player) return 'Lavalink 队列为空。';
    const current = player.queue.current ? `正在播放：**${escapeMarkdownLite(formatTrack(player.queue.current))}**\n` : '';
    const lines = player.queue.tracks.slice(0, 10).map((track, index) => `${index + 1}. ${escapeMarkdownLite(formatTrack(track))}`);
    return lines.length > 0 ? `${current}待播队列：\n${lines.join('\n')}` : `${current}队列为空。`;
  }

  healthText(guildId: string): string[] {
    const player = this.manager?.getPlayer(guildId);
    const nodes = this.manager?.nodeManager.nodes.map(node => `${node.id}:${node.connected ? 'up' : 'down'}`) ?? [];
    return [
      'backend: lavalink',
      `nodes: ${nodes.length ? nodes.join(', ') : 'none'}`,
      `voice: ${player?.connected ? 'connected' : 'disconnected'}`,
      `current: ${player?.queue.current ? 'yes' : 'no'}`,
      `paused: ${player?.paused ? 'yes' : 'no'}`,
      `queued: ${player?.queue.tracks.length ?? 0}`,
      `volume: ${player?.volume ?? 'n/a'}%`,
      `repeat: ${player ? fromLavalinkRepeatMode(player.repeatMode) : 'off'}`,
      `fallback: ${this.config.fallbackSearchSource ? `${this.config.searchSource}->${this.config.fallbackSearchSource}` : 'disabled'}`
    ];
  }

  private getOrCreatePlayer(voiceChannel: VoiceBasedChannel, textChannelId: string) {
    if (!this.manager) throw new Error('Lavalink is disabled');
    return this.manager.createPlayer({
      guildId: voiceChannel.guild.id,
      voiceChannelId: voiceChannel.id,
      textChannelId,
      selfDeaf: true,
      selfMute: false,
      volume: 80
    });
  }

  private shouldFallbackFrom(source: SearchPlatform): boolean {
    const primary = String(source).toLowerCase();
    const fallback = String(this.config.fallbackSearchSource ?? '').toLowerCase();
    if (!fallback || fallback === primary) return false;
    return primary.startsWith('yt') || primary.includes('youtube');
  }

  private registerFallbackContexts(
    tracks: any[],
    input: Omit<PlaybackFallbackContext, 'fallbackQuery' | 'createdAt' | 'attempted'>
  ): void {
    this.gcFallbackContexts();
    for (const track of tracks) {
      const key = trackKey(track);
      if (!key) continue;
      this.fallbackByTrackKey.set(key, {
        ...input,
        fallbackQuery: buildFallbackQuery(track, input.originalQuery),
        createdAt: Date.now(),
        attempted: false
      });
    }
  }

  private getFallbackContext(track: any): PlaybackFallbackContext | undefined {
    const key = trackKey(track);
    return key ? this.fallbackByTrackKey.get(key) : undefined;
  }

  private deleteFallbackContext(track: any): void {
    const key = trackKey(track);
    if (key) this.fallbackByTrackKey.delete(key);
  }

  private async handlePlaybackFailure(player: any, track: any, payload: unknown, eventName: 'trackError' | 'trackStuck'): Promise<void> {
    const context = this.getFallbackContext(track);
    if (!context || context.attempted) {
      this.logger.warn({ guildId: player.guildId, track: track ? formatTrack(track) : undefined, payload, eventName }, 'lavalink playback failed without fallback');
      return;
    }

    context.attempted = true;
    this.deleteFallbackContext(track);

    if (this.fallbackInFlightGuilds.has(player.guildId)) {
      this.logger.warn({ guildId: player.guildId, originalQuery: context.originalQuery }, 'fallback already in flight for guild');
      return;
    }

    this.fallbackInFlightGuilds.add(player.guildId);
    try {
      const result = await player.search({ query: context.fallbackQuery, source: context.fallbackSource }, context.requester, false) as any;
      const tracks = Array.isArray(result.tracks) ? result.tracks : [];
      const fallbackTrack = tracks[0];
      if (!fallbackTrack) {
        this.logger.error({ guildId: player.guildId, originalQuery: context.originalQuery, fallbackQuery: context.fallbackQuery, fallbackSource: context.fallbackSource }, 'fallback search returned no tracks');
        await this.sendTextChannelMessage(context.textChannelId, `YouTube 播放失败，SoundCloud 也没有找到可播放结果：**${escapeMarkdownLite(context.originalQuery)}**`);
        return;
      }

      await player.play({ clientTrack: fallbackTrack });
      const title = formatTrack(fallbackTrack);
      this.logger.warn({
        guildId: player.guildId,
        originalQuery: context.originalQuery,
        fallbackQuery: context.fallbackQuery,
        fallbackSource: context.fallbackSource,
        title,
        eventName
      }, 'youtube playback failed; switched to fallback source');
      await this.sendTextChannelMessage(context.textChannelId, `YouTube 播放失败，已自动切到 SoundCloud：**${escapeMarkdownLite(title)}**`);
    } catch (error) {
      this.logger.error({ err: error, guildId: player.guildId, originalQuery: context.originalQuery, fallbackSource: context.fallbackSource }, 'fallback playback failed');
      await this.sendTextChannelMessage(context.textChannelId, `YouTube 播放失败，自动切换 SoundCloud 也失败了：**${escapeMarkdownLite(context.originalQuery)}**`);
    } finally {
      this.fallbackInFlightGuilds.delete(player.guildId);
    }
  }

  private async sendTextChannelMessage(textChannelId: string, message: string): Promise<void> {
    const channel = await this.client.channels.fetch(textChannelId).catch(() => undefined) as any;
    if (!channel || typeof channel.send !== 'function') return;
    await channel.send(message).catch((error: unknown) => {
      this.logger.warn({ err: error, textChannelId }, 'failed to send fallback notification');
    });
  }

  private gcFallbackContexts(): void {
    const now = Date.now();
    for (const [key, context] of this.fallbackByTrackKey) {
      if (now - context.createdAt > fallbackContextTtlMs) {
        this.fallbackByTrackKey.delete(key);
      }
    }
  }
}

function toLavalinkRepeatMode(mode: RepeatMode): LavalinkRepeatMode {
  if (mode === 'one') return 'track';
  if (mode === 'all') return 'queue';
  return 'off';
}

function fromLavalinkRepeatMode(mode: LavalinkRepeatMode): RepeatMode {
  if (mode === 'track') return 'one';
  if (mode === 'queue') return 'all';
  return 'off';
}

function trackKey(track: Track | any): string | undefined {
  if (!track) return undefined;
  if (track.encoded) return `encoded:${track.encoded}`;
  const info = track.info ?? {};
  if (info.sourceName && info.identifier) return `${info.sourceName}:${info.identifier}`;
  if (info.title) return `${info.sourceName ?? 'unknown'}:${info.author ?? ''}:${info.title}`;
  return undefined;
}

function buildFallbackQuery(track: Track | any, originalQuery: string): string {
  const info = track?.info ?? {};
  const title = typeof info.title === 'string' ? info.title : '';
  const author = typeof info.author === 'string' ? info.author : '';
  return [author, title].filter(Boolean).join(' ').trim() || originalQuery;
}

function formatTrack(track: Track | any): string {
  const info = track?.info ?? {};
  const title = info.title ?? 'Unknown Track';
  const author = info.author;
  return author ? `${author} - ${title}` : title;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function escapeMarkdownLite(value: string): string {
  return value.replaceAll('`', '\\`').replaceAll('*', '\\*').replaceAll('_', '\\_');
}
