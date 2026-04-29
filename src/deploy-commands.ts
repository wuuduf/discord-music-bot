import { REST, Routes } from 'discord.js';
import { loadEnv } from './config/env.js';
import { restCommandPayload } from './discord/commands.js';
import { createLogger } from './utils/logger.js';

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);
const rest = new REST({ version: '10' }).setToken(env.DISCORD_TOKEN);

if (env.DISCORD_GUILD_ID) {
  await rest.put(
    Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.DISCORD_GUILD_ID),
    { body: restCommandPayload }
  );
  logger.info({ guildId: env.DISCORD_GUILD_ID, count: restCommandPayload.length }, 'registered guild slash commands');
} else {
  await rest.put(
    Routes.applicationCommands(env.DISCORD_CLIENT_ID),
    { body: restCommandPayload }
  );
  logger.info({ count: restCommandPayload.length }, 'registered global slash commands');
}
