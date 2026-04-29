import { randomUUID } from 'node:crypto';
import type { ResolvedTrack } from './source-resolver.js';

export type GuessRound = {
  id: string;
  guildId: string;
  textChannelId: string;
  startedBy: string;
  track: ResolvedTrack;
  startedAt: Date;
  answerCount: number;
  hintCount: number;
};

export type GuessResult =
  | { ok: true; round: GuessRound }
  | { ok: false; reason: 'no_round' | 'already_solved'; round?: GuessRound };

export class GuessGameManager {
  private readonly rounds = new Map<string, GuessRound>();

  hasActiveRound(guildId: string): boolean {
    return this.rounds.has(guildId);
  }

  getRound(guildId: string): GuessRound | undefined {
    return this.rounds.get(guildId);
  }

  startRound(input: Omit<GuessRound, 'id' | 'startedAt' | 'answerCount' | 'hintCount'>): GuessRound {
    const round: GuessRound = {
      ...input,
      id: randomUUID(),
      startedAt: new Date(),
      answerCount: 0,
      hintCount: 0
    };
    this.rounds.set(input.guildId, round);
    return round;
  }

  stopRound(guildId: string): GuessRound | undefined {
    const round = this.rounds.get(guildId);
    this.rounds.delete(guildId);
    return round;
  }

  answer(guildId: string, rawAnswer: string): GuessResult {
    const round = this.rounds.get(guildId);
    if (!round) return { ok: false, reason: 'no_round' };

    round.answerCount++;
    if (isCorrectGuess(rawAnswer, round.track)) {
      this.rounds.delete(guildId);
      return { ok: true, round };
    }

    return { ok: false, reason: 'already_solved', round };
  }

  buildHint(guildId: string): string | undefined {
    const round = this.rounds.get(guildId);
    if (!round) return undefined;

    round.hintCount++;
    const titleHint = maskText(round.track.title, round.hintCount);
    const artistHint = round.track.artist ? maskText(round.track.artist, Math.max(1, round.hintCount - 1)) : '未知歌手';
    return `歌名：${titleHint}\n歌手：${artistHint}\n已猜次数：${round.answerCount}`;
  }
}

export function formatGuessAnswer(track: ResolvedTrack): string {
  const artist = track.artist ? `${track.artist} - ` : '';
  return `${artist}${track.title}`;
}

function isCorrectGuess(rawAnswer: string, track: ResolvedTrack): boolean {
  const answer = normalizeGuess(rawAnswer);
  const title = normalizeGuess(track.title);
  const artist = normalizeGuess(track.artist ?? '');
  const full = normalizeGuess(`${track.artist ?? ''} ${track.title}`);

  if (!answer || !title) return false;
  if (answer === title || answer === full) return true;
  if (artist && answer.includes(artist) && answer.includes(title)) return true;

  const maxDistance = Math.max(1, Math.floor(title.length * 0.18));
  return levenshtein(answer, title) <= maxDistance;
}

function normalizeGuess(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '')
    .trim();
}

function maskText(value: string, revealLevel: number): string {
  const chars = Array.from(value);
  const visibleEvery = Math.max(2, 6 - revealLevel);
  return chars.map((ch, index) => {
    if (/\s/u.test(ch)) return ch;
    if (/[^\p{Letter}\p{Number}]/u.test(ch)) return ch;
    return index % visibleEvery === 0 ? ch : '＿';
  }).join('');
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[a.length][b.length];
}
