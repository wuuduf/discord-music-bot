import { SlashCommandBuilder } from 'discord.js';

export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check whether the bot is alive.'),

  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a direct URL or search keyword in your voice channel.')
    .addStringOption(option => option
      .setName('query')
      .setDescription('Direct URL or song keywords.')
      .setRequired(true)),

  new SlashCommandBuilder()
    .setName('search')
    .setDescription('Search Apple Music/iTunes previews and choose one to play.')
    .addStringOption(option => option
      .setName('query')
      .setDescription('Song keywords.')
      .setRequired(true)),

  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show the current guild queue.'),

  new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Show the current track.'),

  new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Pause current playback.'),

  new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Resume paused playback.'),

  new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Set playback volume for this guild.')
    .addIntegerOption(option => option
      .setName('value')
      .setDescription('Volume from 0 to 100.')
      .setMinValue(0)
      .setMaxValue(100)
      .setRequired(true)),

  new SlashCommandBuilder()
    .setName('repeat')
    .setDescription('Set repeat mode.')
    .addStringOption(option => option
      .setName('mode')
      .setDescription('Repeat mode.')
      .setRequired(true)
      .addChoices(
        { name: 'off', value: 'off' },
        { name: 'one', value: 'one' },
        { name: 'all', value: 'all' }
      )),

  new SlashCommandBuilder()
    .setName('shuffle')
    .setDescription('Shuffle the queued tracks.'),

  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove a queued track by its queue position.')
    .addIntegerOption(option => option
      .setName('position')
      .setDescription('1-based queue position from /queue.')
      .setMinValue(1)
      .setRequired(true)),

  new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Clear queued tracks without stopping the current track.'),

  new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skip the current track.'),

  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop playback, leave voice, and clear the queue.'),

  new SlashCommandBuilder()
    .setName('djrole')
    .setDescription('Set or clear the DJ role required for playback control commands.')
    .addRoleOption(option => option
      .setName('role')
      .setDescription('Role allowed to control playback. Omit to clear.')
      .setRequired(false)),



  new SlashCommandBuilder()
    .setName('guess')
    .setDescription('Guess-the-song game mode using Apple Music/iTunes previews.')
    .addSubcommand(subcommand => subcommand
      .setName('start')
      .setDescription('Start a guess-the-song round.')
      .addStringOption(option => option
        .setName('query')
        .setDescription('Song search seed, e.g. artist, genre, or keywords.')
        .setRequired(true)))
    .addSubcommand(subcommand => subcommand
      .setName('answer')
      .setDescription('Submit your guess for the current round.')
      .addStringOption(option => option
        .setName('text')
        .setDescription('Your song title guess.')
        .setRequired(true)))
    .addSubcommand(subcommand => subcommand
      .setName('hint')
      .setDescription('Show a masked hint for the current round.'))
    .addSubcommand(subcommand => subcommand
      .setName('status')
      .setDescription('Show current guess round status.'))
    .addSubcommand(subcommand => subcommand
      .setName('reveal')
      .setDescription('Reveal the answer and stop the current guess round.'))
    .addSubcommand(subcommand => subcommand
      .setName('stop')
      .setDescription('Stop the current guess round without starting a new one.')),

  new SlashCommandBuilder()
    .setName('health')
    .setDescription('Show basic runtime health for this guild.')
];

export const restCommandPayload = commandDefinitions.map(command => command.toJSON());
