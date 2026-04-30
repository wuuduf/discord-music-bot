import 'dotenv/config';
import { z } from 'zod';

const booleanFromEnv = z.preprocess(value => {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return value;
}, z.boolean());

const optionalStringFromEnv = z.preprocess(value => {
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
}, z.string().min(1).optional());

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1, 'DISCORD_TOKEN is required'),
  DISCORD_CLIENT_ID: z.string().min(1, 'DISCORD_CLIENT_ID is required'),
  DISCORD_GUILD_ID: optionalStringFromEnv,
  AUDIO_BACKEND: z.enum(['builtin', 'lavalink']).default('builtin'),
  LAVALINK_HOST: z.string().min(1).default('localhost'),
  LAVALINK_PORT: z.coerce.number().int().min(1).max(65_535).default(2333),
  LAVALINK_PASSWORD: z.string().min(1).default('youshallnotpass'),
  LAVALINK_SECURE: booleanFromEnv.default(false),
  LAVALINK_SEARCH_SOURCE: z.string().min(1).default('ytmsearch'),
  LAVALINK_FALLBACK_SEARCH_SOURCE: z.string().min(1).default('scsearch'),
  YTDLP_ENABLED: booleanFromEnv.default(true),
  YTDLP_FALLBACK_MODE: z.enum(['direct', 'cache']).default('direct'),
  YTDLP_BIN: z.string().min(1).default('yt-dlp'),
  YTDLP_FORMAT: z.string().min(1).default('bestaudio[ext=m4a]/bestaudio/best'),
  YTDLP_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(600_000).default(180_000),
  YTDLP_CACHE_DIR: z.string().min(1).default('runtime/cache'),
  YTDLP_CACHE_PUBLIC_BASE_URL: z.string().url().default('http://discord-music-bot:3000'),
  YTDLP_CACHE_HTTP_HOST: z.string().min(1).default('0.0.0.0'),
  YTDLP_CACHE_HTTP_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  YTDLP_CACHE_HTTP_TOKEN: optionalStringFromEnv,
  YTDLP_CACHE_MAX_MB: z.coerce.number().int().min(128).max(20_000).default(2048),
  YTDLP_CACHE_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(72),
  YTDLP_COOKIES_PATH: optionalStringFromEnv,
  YTDLP_EXTRACTOR_ARGS: optionalStringFromEnv,
  YTDLP_JS_RUNTIMES: optionalStringFromEnv.default('node'),
  YTDLP_REMOTE_COMPONENTS: optionalStringFromEnv,
  ITUNES_COUNTRY: z.string().min(2).max(2).default('us'),
  STORAGE_PATH: z.string().min(1).default('runtime/bot.sqlite'),
  MAX_QUEUE_SIZE: z.coerce.number().int().min(1).max(500).default(50),
  USER_COOLDOWN_MS: z.coerce.number().int().min(0).max(60_000).default(3_000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info')
});

export type AppEnv = z.infer<typeof envSchema>;

export function loadEnv(): AppEnv {
  return envSchema.parse(process.env);
}
