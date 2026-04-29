export type TrackSource = 'apple_music' | 'url' | 'test';

export type RepeatMode = 'off' | 'one' | 'all';

export type QueueItem = {
  requestId: string;
  guildId: string;
  textChannelId: string;
  voiceChannelId?: string;
  requestedBy: string;
  title: string;
  artist?: string;
  durationMs?: number;
  source: TrackSource;
  sourceUrl: string;
  playableUrl?: string;
  artworkUrl?: string;
  createdAt: Date;
};

export type GuildQueue = {
  guildId: string;
  current?: QueueItem;
  items: QueueItem[];
  volume: number;
  repeatMode: RepeatMode;
  djRoleId?: string;
};
