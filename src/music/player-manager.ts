import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  type AudioPlayer,
  type AudioPlayerError,
  type DiscordGatewayAdapterCreator,
  type VoiceConnection
} from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';
import type { Logger } from 'pino';
import { QueueManager } from './queue-manager.js';
import type { QueueItem } from './types.js';

const require = createRequire(import.meta.url);
const ffmpegPath = require('ffmpeg-static') as string | null;

if (typeof ffmpegPath === 'string' && !process.env.FFMPEG_PATH) {
  process.env.FFMPEG_PATH = ffmpegPath;
}

type GuildPlayerState = {
  guildId: string;
  textChannelId: string;
  voiceChannelId: string;
  connection: VoiceConnection;
  player: AudioPlayer;
  stopping: boolean;
  transitioning: boolean;
};

export class PlayerManager {
  private readonly states = new Map<string, GuildPlayerState>();

  constructor(
    private readonly queueManager: QueueManager,
    private readonly logger: Logger
  ) {}

  async ensurePlaying(voiceChannel: VoiceBasedChannel, textChannelId: string): Promise<void> {
    const state = await this.getOrCreateState(voiceChannel, textChannelId);

    if (state.player.state.status === AudioPlayerStatus.Idle && !state.transitioning) {
      await this.playNext(state.guildId);
    }
  }

  skip(guildId: string): boolean {
    const state = this.states.get(guildId);
    if (!state || state.player.state.status === AudioPlayerStatus.Idle) {
      return false;
    }

    const current = this.queueManager.getQueue(guildId).current;
    if (current) {
      this.queueManager.markCurrentSkipped(guildId);
    }
    state.player.stop(true);
    return true;
  }

  stop(guildId: string): boolean {
    const state = this.states.get(guildId);
    this.queueManager.clear(guildId);
    if (!state) {
      return false;
    }

    this.destroyState(guildId, true);
    return true;
  }

  pause(guildId: string): boolean {
    const state = this.states.get(guildId);
    if (!state || state.player.state.status !== AudioPlayerStatus.Playing) {
      return false;
    }
    return state.player.pause(true);
  }

  resume(guildId: string): boolean {
    const state = this.states.get(guildId);
    if (!state || state.player.state.status !== AudioPlayerStatus.Paused) {
      return false;
    }
    return state.player.unpause();
  }

  isPaused(guildId: string): boolean {
    return this.states.get(guildId)?.player.state.status === AudioPlayerStatus.Paused;
  }

  setVolume(guildId: string, volume: number): number {
    const normalized = this.queueManager.setVolume(guildId, volume);
    const state = this.states.get(guildId);
    const playerState = state?.player.state;
    if (playerState && playerState.status !== AudioPlayerStatus.Idle) {
      playerState.resource.volume?.setVolume(normalized / 100);
    }
    return normalized;
  }

  isConnected(guildId: string): boolean {
    return this.states.has(guildId);
  }

  private async getOrCreateState(voiceChannel: VoiceBasedChannel, textChannelId: string): Promise<GuildPlayerState> {
    const guildId = voiceChannel.guild.id;
    const existing = this.states.get(guildId);
    if (existing && existing.voiceChannelId === voiceChannel.id) {
      existing.textChannelId = textChannelId;
      return existing;
    }

    if (existing) {
      this.destroyState(guildId, true);
    }

    const player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Play
      }
    });

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator as DiscordGatewayAdapterCreator,
      selfDeaf: true,
      selfMute: false
    });

    const state: GuildPlayerState = {
      guildId,
      textChannelId,
      voiceChannelId: voiceChannel.id,
      connection,
      player,
      stopping: false,
      transitioning: false
    };

    player.on(AudioPlayerStatus.Idle, () => {
      if (!state.stopping) {
        void this.playNext(guildId);
      }
    });

    player.on('error', (error: AudioPlayerError) => {
      const metadata = error.resource.metadata as QueueItem | null;
      this.logger.error(
        { err: error, guildId, requestId: metadata?.requestId, title: metadata?.title },
        'audio player failed; skipping to next item'
      );
      if (!state.stopping) {
        this.queueManager.markCurrentFailed(guildId);
        void this.playNext(guildId);
      }
    });

    connection.on(VoiceConnectionStatus.Disconnected, () => {
      if (state.stopping) return;
      this.logger.warn({ guildId, voiceChannelId: voiceChannel.id }, 'voice connection disconnected');
      this.destroyState(guildId, true);
    });

    connection.subscribe(player);
    this.states.set(guildId, state);

    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    this.logger.info({ guildId, voiceChannelId: voiceChannel.id }, 'voice connection ready');
    return state;
  }

  private async playNext(guildId: string): Promise<void> {
    const state = this.states.get(guildId);
    if (!state || state.stopping || state.transitioning) {
      return;
    }

    const item = this.queueManager.next(guildId);
    if (!item) {
      this.queueManager.finishCurrent(guildId);
      this.logger.info({ guildId }, 'queue is empty; leaving voice channel');
      this.destroyState(guildId, false);
      return;
    }

    state.transitioning = true;
    try {
      const resource = await this.createResource(item);
      const queue = this.queueManager.getQueue(guildId);
      resource.volume?.setVolume(queue.volume / 100);
      state.player.play(resource);
      this.logger.info({ guildId, requestId: item.requestId, title: item.title }, 'started playback');
    } catch (error) {
      this.logger.error({ err: error, guildId, requestId: item.requestId, sourceUrl: item.sourceUrl }, 'failed to create audio resource');
      this.queueManager.markCurrentFailed(guildId);
      state.transitioning = false;
      await this.playNext(guildId);
      return;
    }

    state.transitioning = false;
  }

  private async createResource(item: QueueItem) {
    const source = item.playableUrl ?? item.sourceUrl;
    if (!isHttpUrl(source)) {
      throw new Error(`Phase 2 only supports direct http(s) audio URLs: ${source}`);
    }

    const response = await fetch(source, {
      headers: {
        'user-agent': 'discord-music-bot/phase2'
      }
    });
    if (!response.ok || !response.body) {
      throw new Error(`audio source fetch failed: ${response.status} ${response.statusText}`);
    }

    const stream = Readable.fromWeb(response.body as any);
    return createAudioResource(stream, {
      inlineVolume: true,
      metadata: item
    });
  }

  private destroyState(guildId: string, stopping: boolean): void {
    const state = this.states.get(guildId);
    if (!state) return;

    state.stopping = stopping;
    state.player.stop(true);
    try {
      state.connection.destroy();
    } catch {
      // Destroy can throw if the connection is already destroyed.
    }
    this.states.delete(guildId);
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
