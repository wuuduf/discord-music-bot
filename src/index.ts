import { Client, Events, GatewayIntentBits } from 'discord.js';
import type { SearchPlatform } from 'lavalink-client';
import { loadEnv } from './config/env.js';
import { InteractionRouter } from './discord/interaction-router.js';
import { GuessGameManager } from './music/guess-game-manager.js';
import { ITunesResolver } from './music/itunes-resolver.js';
import { LavalinkService } from './music/lavalink-service.js';
import { PlayerManager } from './music/player-manager.js';
import { QueueManager } from './music/queue-manager.js';
import { SqliteStorage } from './storage/sqlite-storage.js';
import { createLogger } from './utils/logger.js';

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);
process.emitWarning = ((original) => {
  return function filteredEmitWarning(warning: string | Error, ...args: any[]) {
    const message = typeof warning === 'string' ? warning : warning.message;
    if (message.includes('SQLite is an experimental feature')) {
      return;
    }
    return original.call(process, warning as any, ...args);
  };
})(process.emitWarning);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ]
});

const storage = new SqliteStorage(env.STORAGE_PATH, logger);
const queueManager = new QueueManager(storage, env.MAX_QUEUE_SIZE);
const playerManager = new PlayerManager(queueManager, logger);
const guessGameManager = new GuessGameManager();
const sourceResolver = new ITunesResolver(env.ITUNES_COUNTRY, logger, storage);
const lavalinkService = new LavalinkService(client, {
  enabled: env.AUDIO_BACKEND === 'lavalink',
  host: env.LAVALINK_HOST,
  port: env.LAVALINK_PORT,
  password: env.LAVALINK_PASSWORD,
  secure: env.LAVALINK_SECURE,
  searchSource: env.LAVALINK_SEARCH_SOURCE as SearchPlatform,
  fallbackSearchSource: env.LAVALINK_FALLBACK_SEARCH_SOURCE as SearchPlatform
}, logger);
const router = new InteractionRouter(queueManager, playerManager, guessGameManager, sourceResolver, logger, {
  userCooldownMs: env.USER_COOLDOWN_MS
}, lavalinkService);

client.once(Events.ClientReady, async readyClient => {
  logger.info({ tag: readyClient.user.tag, audioBackend: env.AUDIO_BACKEND }, 'discord bot ready');
  await lavalinkService.init(readyClient.user).catch(error => {
    logger.error({ err: error }, 'failed to initialize lavalink');
  });
});

client.on('raw', payload => {
  void lavalinkService.sendRawData(payload);
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand() && !interaction.isStringSelectMenu()) return;

  try {
    if (interaction.isChatInputCommand()) {
      await router.handleChatInput(interaction);
      return;
    }
    await router.handleStringSelect(interaction);
  } catch (error) {
    logger.error({ err: error, interactionId: interaction.id }, 'interaction failed');
    const message = '命令执行失败，错误已记录。';
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: message, ephemeral: true }).catch(() => undefined);
    } else {
      await interaction.reply({ content: message, ephemeral: true }).catch(() => undefined);
    }
  }
});

process.on('SIGINT', () => {
  logger.info('received SIGINT, destroying discord client');
  client.destroy();
  storage.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('received SIGTERM, destroying discord client');
  client.destroy();
  storage.close();
  process.exit(0);
});

await client.login(env.DISCORD_TOKEN);
