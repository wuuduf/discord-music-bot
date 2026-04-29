export type ResolvedTrack = {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  durationMs?: number;
  source: 'apple_music' | 'url' | 'test';
  sourceUrl: string;
  playableUrl?: string;
  artworkUrl?: string;
};

export type TrackSearchOptions = {
  limit?: number;
};

export interface SourceResolver {
  search(query: string, options?: TrackSearchOptions): Promise<ResolvedTrack[]>;
}
