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

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1, 'DISCORD_TOKEN is required'),
  DISCORD_CLIENT_ID: z.string().min(1, 'DISCORD_CLIENT_ID is required'),
  DISCORD_GUILD_ID: z.string().min(1).optional(),
  AUDIO_BACKEND: z.enum(['builtin', 'lavalink']).default('builtin'),
  LAVALINK_HOST: z.string().min(1).default('localhost'),
  LAVALINK_PORT: z.coerce.number().int().min(1).max(65_535).default(2333),
  LAVALINK_PASSWORD: z.string().min(1).default('youshallnotpass'),
  LAVALINK_SECURE: booleanFromEnv.default(false),
  LAVALINK_SEARCH_SOURCE: z.string().min(1).default('ytmsearch'),
  LAVALINK_FALLBACK_SEARCH_SOURCE: z.string().min(1).default('scsearch'),
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
