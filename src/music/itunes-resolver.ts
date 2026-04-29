import type { Logger } from 'pino';
import type { ResolvedTrack, SourceResolver, TrackSearchOptions } from './source-resolver.js';
import type { BotStorage } from '../storage/types.js';

type ITunesSearchResponse = {
  resultCount: number;
  results: ITunesTrackResult[];
};

type ITunesTrackResult = {
  wrapperType?: string;
  kind?: string;
  trackId?: number;
  trackName?: string;
  artistName?: string;
  collectionName?: string;
  trackTimeMillis?: number;
  trackViewUrl?: string;
  previewUrl?: string;
  artworkUrl100?: string;
};

export class ITunesResolver implements SourceResolver {
  constructor(
    private readonly country: string,
    private readonly logger: Logger,
    private readonly storage?: BotStorage
  ) {}

  async search(query: string, options: TrackSearchOptions = {}): Promise<ResolvedTrack[]> {
    const limit = clampLimit(options.limit ?? 8);
    const url = new URL('https://itunes.apple.com/search');
    url.searchParams.set('term', query);
    url.searchParams.set('media', 'music');
    url.searchParams.set('entity', 'song');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('country', this.country);

    const response = await fetch(url, {
      headers: {
        'user-agent': 'discord-music-bot/phase3'
      }
    });
    if (!response.ok) {
      throw new Error(`iTunes search failed: ${response.status} ${response.statusText}`);
    }

    const payload = await response.json() as ITunesSearchResponse;
    this.logger.debug({ query, country: this.country, resultCount: payload.resultCount }, 'itunes search completed');

    const tracks = payload.results
      .filter(item => item.wrapperType === 'track' && item.kind === 'song' && item.trackId && item.trackName)
      .map(item => ({
        id: String(item.trackId),
        title: item.trackName ?? 'Unknown Track',
        artist: item.artistName,
        album: item.collectionName,
        durationMs: item.trackTimeMillis,
        source: 'apple_music' as const,
        sourceUrl: item.trackViewUrl ?? `https://music.apple.com/search?term=${encodeURIComponent(query)}`,
        playableUrl: item.previewUrl,
        artworkUrl: upscaleArtwork(item.artworkUrl100)
      }))
      .filter(item => item.playableUrl);

    for (const track of tracks) {
      this.storage?.upsertTrackCache(track);
    }

    return tracks;
  }
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 8;
  return Math.min(Math.max(Math.trunc(limit), 1), 25);
}

function upscaleArtwork(url: string | undefined): string | undefined {
  return url?.replace(/100x100bb\\.(jpg|png|webp)$/i, '600x600bb.$1');
}
