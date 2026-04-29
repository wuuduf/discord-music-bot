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
};

export type LavalinkPlayResult = {
  title: string;
  added: number;
  playlistName?: string;
};

export class LavalinkService {
  readonly manager?: LavalinkManager;

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

    const searchQuery = isHttpUrl(query)
      ? { query }
      : { query, source: this.config.searchSource };
    const result = await player.search(searchQuery, requester, false) as any;
    const tracks = Array.isArray(result.tracks) ? result.tracks : [];
    if (tracks.length === 0) {
      throw new Error(`No Lavalink tracks found for query: ${query}`);
    }

    const toAdd = result.loadType === 'playlist' ? tracks : [tracks[0]];
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
      `repeat: ${player ? fromLavalinkRepeatMode(player.repeatMode) : 'off'}`
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
