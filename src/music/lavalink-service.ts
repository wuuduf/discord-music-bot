import { LavalinkManager, type RepeatMode as LavalinkRepeatMode, type SearchPlatform, type Track } from 'lavalink-client';
import type { Client, User, VoiceBasedChannel } from 'discord.js';
import type { Logger } from 'pino';
import type { RepeatMode } from './types.js';
import type { YtDlpService } from './ytdlp-service.js';

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
  source: string;
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
  skipYtDlp?: boolean;
};

const fallbackContextTtlMs = 30 * 60 * 1000;

export class LavalinkService {
  readonly manager?: LavalinkManager;
  private readonly fallbackByTrackKey = new Map<string, PlaybackFallbackContext>();
  private readonly fallbackInFlightGuilds = new Set<string>();

  constructor(
    private readonly client: Client,
    private readonly config: LavalinkServiceConfig,
    private readonly logger: Logger,
    private readonly ytdlpService?: YtDlpService
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
    const ytdlpPrimaryAttempted = this.shouldUseYtDlpPrimary(query);
    if (ytdlpPrimaryAttempted) {
      const ytdlpResult = await this.tryQueueYtDlpPrimary(player, textChannelId, query, requester);
      if (ytdlpResult) return ytdlpResult;
    }

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
    const shouldRegisterFallback = directUrl
      ? isYoutubeUrl(query)
      : Boolean(primarySource && this.shouldHandlePlaybackFailureFrom(primarySource));
    if (shouldRegisterFallback) {
      this.registerFallbackContexts(toAdd, {
        originalQuery: query,
        primarySource: directUrl ? 'youtube-url' : String(primarySource),
        fallbackSource: this.config.fallbackSearchSource ?? 'scsearch',
        textChannelId,
        requester,
        skipYtDlp: ytdlpPrimaryAttempted
      });
    }

    await player.queue.add(toAdd);
    if (!player.playing && !player.paused) {
      await player.play();
    }

    return {
      title: formatTrack(toAdd[0]),
      added: toAdd.length,
      source: directUrl ? 'direct-url' : String(primarySource),
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
      `fallback: ${this.config.fallbackSearchSource ? `${this.config.searchSource}->${this.config.fallbackSearchSource}` : 'disabled'}`,
      `play_order: ${this.ytdlpService?.enabled ? `yt-dlp-${this.ytdlpService.mode}->${this.config.searchSource}->${this.config.fallbackSearchSource ?? 'none'}` : `${this.config.searchSource}->${this.config.fallbackSearchSource ?? 'none'}`}`,
      ...(this.ytdlpService?.healthText() ?? [])
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


  private shouldUseYtDlpPrimary(query: string): boolean {
    if (!this.ytdlpService?.enabled) return false;
    return !isHttpUrl(query) || isYoutubeUrl(query);
  }

  private async tryQueueYtDlpPrimary(
    player: any,
    textChannelId: string,
    query: string,
    requester: unknown
  ): Promise<LavalinkPlayResult | undefined> {
    try {
      const { resolved, track, title } = await this.loadYtDlpTrack(player, query, requester);
      this.registerFallbackContexts([track], {
        originalQuery: query,
        primarySource: `ytdlp-${resolved.mode}`,
        fallbackSource: this.config.searchSource,
        textChannelId,
        requester,
        skipYtDlp: true
      });

      await player.queue.add([track]);
      if (!player.playing && !player.paused) {
        await player.play();
      }

      this.logger.info({
        guildId: player.guildId,
        query,
        ytdlpMode: resolved.mode,
        videoId: resolved.videoId,
        cachedPath: resolved.cachedPath,
        title
      }, 'queued yt-dlp primary track request');
      return { title, added: 1, source: `yt-dlp-${resolved.mode}` };
    } catch (error) {
      this.logger.warn({ err: error, guildId: player.guildId, query }, 'yt-dlp primary playback failed; falling back to lavalink search');
      return undefined;
    }
  }

  private async loadYtDlpTrack(player: any, query: string, requester: unknown): Promise<{ resolved: Awaited<ReturnType<YtDlpService['resolve']>>; track: any; title: string }> {
    if (!this.ytdlpService?.enabled) throw new Error('yt-dlp is disabled');
    const resolved = await this.ytdlpService.resolve(query);
    const result = await player.search({ query: resolved.playUrl }, requester, false) as any;
    const tracks = Array.isArray(result.tracks) ? result.tracks : [];
    const track = tracks[0];
    if (!track) throw new Error('Lavalink could not load yt-dlp media URL');
    const loadedTitle = formatTrack(track);
    const title = isUnknownTrackTitle(loadedTitle) ? resolved.title : loadedTitle;
    return { resolved, track, title };
  }

  private shouldHandlePlaybackFailureFrom(source: SearchPlatform): boolean {
    const primary = String(source).toLowerCase();
    return primary.startsWith('yt') || primary.includes('youtube');
  }

  private hasSearchSourceFallback(context: PlaybackFallbackContext): boolean {
    const primary = context.primarySource.toLowerCase();
    const fallback = String(context.fallbackSource ?? '').toLowerCase();
    return Boolean(fallback) && fallback !== primary;
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
    let ytdlpAttempted = Boolean(context.skipYtDlp);
    try {
      if (this.ytdlpService?.enabled && !context.skipYtDlp) {
        ytdlpAttempted = true;
        if (await this.tryYtDlpFallback(player, context, eventName)) return;
      }

      await this.trySearchSourceFallback(player, context, eventName, ytdlpAttempted);
    } finally {
      this.fallbackInFlightGuilds.delete(player.guildId);
    }
  }

  private async tryYtDlpFallback(player: any, context: PlaybackFallbackContext, eventName: 'trackError' | 'trackStuck'): Promise<boolean> {
    if (!this.ytdlpService?.enabled) return false;
    try {
      const { resolved, track: fallbackTrack, title } = await this.loadYtDlpTrack(player, context.fallbackQuery || context.originalQuery, context.requester);

      this.registerFallbackContexts([fallbackTrack], {
        originalQuery: context.originalQuery,
        primarySource: `ytdlp-${resolved.mode}`,
        fallbackSource: context.fallbackSource,
        textChannelId: context.textChannelId,
        requester: context.requester,
        skipYtDlp: true
      });
      await player.play({ clientTrack: fallbackTrack });
      this.logger.warn({
        guildId: player.guildId,
        originalQuery: context.originalQuery,
        fallbackQuery: context.fallbackQuery,
        ytdlpMode: resolved.mode,
        videoId: resolved.videoId,
        cachedPath: resolved.cachedPath,
        title,
        eventName
      }, 'playback failed; switched to yt-dlp fallback');
      await this.sendTextChannelMessage(
        context.textChannelId,
        `播放失败，已自动切到 yt-dlp ${resolved.mode === 'cache' ? '缓存' : '直链'}：**${escapeMarkdownLite(title)}**`
      );
      return true;
    } catch (error) {
      this.logger.error({ err: error, guildId: player.guildId, originalQuery: context.originalQuery, fallbackQuery: context.fallbackQuery }, 'yt-dlp fallback playback failed');
      return false;
    }
  }

  private async trySearchSourceFallback(
    player: any,
    context: PlaybackFallbackContext,
    eventName: 'trackError' | 'trackStuck',
    ytdlpAttempted: boolean
  ): Promise<void> {
    if (!this.hasSearchSourceFallback(context)) {
      this.logger.warn({ guildId: player.guildId, originalQuery: context.originalQuery, ytdlpAttempted }, 'no secondary search source fallback configured');
      const prefix = ytdlpAttempted ? 'yt-dlp 直链也失败，且没有配置其他搜索源 fallback' : '没有配置其他搜索源 fallback';
      await this.sendTextChannelMessage(context.textChannelId, `播放失败，${prefix}：**${escapeMarkdownLite(context.originalQuery)}**`);
      return;
    }

    try {
      const result = await player.search({ query: context.fallbackQuery, source: context.fallbackSource }, context.requester, false) as any;
      const tracks = Array.isArray(result.tracks) ? result.tracks : [];
      const fallbackTrack = tracks[0];
      if (!fallbackTrack) {
        this.logger.error({ guildId: player.guildId, originalQuery: context.originalQuery, fallbackQuery: context.fallbackQuery, fallbackSource: context.fallbackSource, ytdlpAttempted }, 'fallback search returned no tracks');
        const targetLabel = searchSourceLabel(context.fallbackSource);
        const prefix = ytdlpAttempted ? `yt-dlp 直链也失败，${targetLabel} 也没有找到可播放结果` : `${targetLabel} 也没有找到可播放结果`;
        await this.sendTextChannelMessage(context.textChannelId, `播放失败，${prefix}：**${escapeMarkdownLite(context.originalQuery)}**`);
        return;
      }

      this.registerNextFailureFallback(fallbackTrack, context);
      await player.play({ clientTrack: fallbackTrack });
      const title = formatTrack(fallbackTrack);
      this.logger.warn({
        guildId: player.guildId,
        originalQuery: context.originalQuery,
        fallbackQuery: context.fallbackQuery,
        fallbackSource: context.fallbackSource,
        ytdlpAttempted,
        title,
        eventName
      }, 'playback failed; switched to fallback source');
      const targetLabel = searchSourceLabel(context.fallbackSource);
      const prefix = ytdlpAttempted ? `yt-dlp 直链失败后，已自动切到 ${targetLabel}` : `已自动切到 ${targetLabel}`;
      await this.sendTextChannelMessage(context.textChannelId, `播放失败，${prefix}：**${escapeMarkdownLite(title)}**`);
    } catch (error) {
      this.logger.error({ err: error, guildId: player.guildId, originalQuery: context.originalQuery, fallbackSource: context.fallbackSource, ytdlpAttempted }, 'fallback playback failed');
      const targetLabel = searchSourceLabel(context.fallbackSource);
      const prefix = ytdlpAttempted ? `yt-dlp 直链和 ${targetLabel} 自动切换都失败了` : `自动切换 ${targetLabel} 也失败了`;
      await this.sendTextChannelMessage(context.textChannelId, `播放失败，${prefix}：**${escapeMarkdownLite(context.originalQuery)}**`);
    }
  }

  private registerNextFailureFallback(track: any, context: PlaybackFallbackContext): void {
    if (!this.shouldHandlePlaybackFailureFrom(context.fallbackSource)) return;
    const fallbackSearchSource = this.config.fallbackSearchSource;
    if (!fallbackSearchSource) return;
    const currentSource = String(context.fallbackSource).toLowerCase();
    const nextSource = String(fallbackSearchSource).toLowerCase();
    if (nextSource === currentSource) return;

    const key = trackKey(track);
    if (!key) return;
    this.fallbackByTrackKey.set(key, {
      originalQuery: context.originalQuery,
      primarySource: String(context.fallbackSource),
      fallbackSource: fallbackSearchSource,
      textChannelId: context.textChannelId,
      requester: context.requester,
      fallbackQuery: buildFallbackQuery(track, context.originalQuery),
      createdAt: Date.now(),
      attempted: false,
      skipYtDlp: true
    });
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

function isUnknownTrackTitle(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === 'unknown track'
    || normalized === 'unknown title'
    || normalized === 'unknown artist - unknown title'
    || normalized === 'unknown author - unknown track';
}

function searchSourceLabel(source: SearchPlatform): string {
  const normalized = String(source).toLowerCase();
  if (normalized.startsWith('ytm')) return 'YouTube Music';
  if (normalized.startsWith('yt')) return 'YouTube';
  if (normalized.startsWith('sc') || normalized.includes('soundcloud')) return 'SoundCloud';
  return String(source);
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isYoutubeUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === 'youtu.be' || hostname.endsWith('.youtube.com') || hostname === 'youtube.com' || hostname.endsWith('.youtube-nocookie.com');
  } catch {
    return false;
  }
}

function escapeMarkdownLite(value: string): string {
  return value.replaceAll('`', '\\`').replaceAll('*', '\\*').replaceAll('_', '\\_');
}
