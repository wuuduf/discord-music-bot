import { randomUUID } from 'node:crypto';
import type { ChatInputCommandInteraction, StringSelectMenuInteraction } from 'discord.js';
import {
  ActionRowBuilder,
  inlineCode,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder
} from 'discord.js';
import type { Logger } from 'pino';
import { GuessGameManager, formatGuessAnswer } from '../music/guess-game-manager.js';
import { LavalinkService, type LavalinkPlayResult } from '../music/lavalink-service.js';
import { PlayerManager } from '../music/player-manager.js';
import { QueueLimitError, QueueManager } from '../music/queue-manager.js';
import type { ResolvedTrack, SourceResolver } from '../music/source-resolver.js';
import type { QueueItem, RepeatMode } from '../music/types.js';

type PendingSearch = {
  id: string;
  guildId: string;
  textChannelId: string;
  requestedBy: string;
  createdAt: number;
  results: ResolvedTrack[];
};

const pendingSearchTTL = 10 * 60 * 1000;

type InteractionRouterOptions = {
  userCooldownMs: number;
};

export class InteractionRouter {
  private readonly pendingSearches = new Map<string, PendingSearch>();
  private readonly cooldowns = new Map<string, number>();

  constructor(
    private readonly queueManager: QueueManager,
    private readonly playerManager: PlayerManager,
    private readonly guessGameManager: GuessGameManager,
    private readonly sourceResolver: SourceResolver,
    private readonly logger: Logger,
    private readonly options: InteractionRouterOptions,
    private readonly lavalinkService?: LavalinkService
  ) {}

  async handleChatInput(interaction: ChatInputCommandInteraction): Promise<void> {
    switch (interaction.commandName) {
      case 'ping':
        await interaction.reply({ content: `pong ${inlineCode(`${interaction.client.ws.ping}ms`)}`, ephemeral: true });
        return;
      case 'play':
        await this.handlePlay(interaction);
        return;
      case 'search':
        await this.handleSearch(interaction);
        return;
      case 'queue':
        await this.handleQueue(interaction);
        return;
      case 'nowplaying':
        await this.handleNowPlaying(interaction);
        return;
      case 'pause':
        await this.handlePause(interaction);
        return;
      case 'resume':
        await this.handleResume(interaction);
        return;
      case 'volume':
        await this.handleVolume(interaction);
        return;
      case 'repeat':
        await this.handleRepeat(interaction);
        return;
      case 'shuffle':
        await this.handleShuffle(interaction);
        return;
      case 'remove':
        await this.handleRemove(interaction);
        return;
      case 'clear':
        await this.handleClear(interaction);
        return;
      case 'skip':
        await this.handleSkip(interaction);
        return;
      case 'stop':
        await this.handleStop(interaction);
        return;
      case 'djrole':
        await this.handleDjRole(interaction);
        return;
      case 'guess':
        await this.handleGuess(interaction);
        return;
      case 'health':
        await this.handleHealth(interaction);
        return;
      default:
        await interaction.reply({ content: '未知命令。', ephemeral: true });
    }
  }

  private async handlePlay(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({ content: '请在服务器内使用 /play。', ephemeral: true });
      return;
    }
    if (await this.rejectIfCoolingDown(interaction, 'enqueue')) return;

    const query = interaction.options.getString('query', true).trim();
    const member = await interaction.guild?.members.fetch(interaction.user.id);
    const voiceChannel = member?.voice.channel;
    if (!voiceChannel) {
      await interaction.reply({ content: '请先加入一个语音频道，再使用 /play。', ephemeral: true });
      return;
    }

    if (!voiceChannel.joinable) {
      await interaction.reply({ content: '我没有加入该语音频道的权限。', ephemeral: true });
      return;
    }

    await interaction.deferReply();

    if (this.useLavalink()) {
      try {
        const result = await this.lavalinkService!.play(voiceChannel, interaction.channelId, query, {
          id: interaction.user.id,
          username: interaction.user.username
        });
        this.logger.info({ guildId: interaction.guildId, query, added: result.added }, 'queued lavalink track request');
        await interaction.editReply(formatLavalinkPlayResult(result));
      } catch (error) {
        this.logger.error({ err: error, guildId: interaction.guildId, query }, 'lavalink play failed');
        await interaction.editReply(formatLavalinkError(error));
      }
      return;
    }

    let item: QueueItem;
    try {
      item = isHttpUrl(query)
        ? this.queueManager.enqueue({
          guildId: interaction.guildId,
          textChannelId: interaction.channelId,
          voiceChannelId: voiceChannel.id,
          requestedBy: interaction.user.id,
          title: query,
          source: 'url',
          sourceUrl: query
        })
        : await this.resolveFirstAndEnqueue(interaction, query, voiceChannel.id);
    } catch (error) {
      await interaction.editReply(formatEnqueueError(error));
      return;
    }

    await this.playerManager.ensurePlaying(voiceChannel, interaction.channelId);

    this.logger.info({ guildId: interaction.guildId, requestId: item.requestId, query }, 'queued track request');
    await interaction.editReply(`已加入队列：**${escapeMarkdownLite(item.title)}**\n请求 ID：${inlineCode(item.requestId)}`);
  }

  private async handleSearch(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({ content: '请在服务器内使用 /search。', ephemeral: true });
      return;
    }
    if (await this.rejectIfCoolingDown(interaction, 'search')) return;

    const query = interaction.options.getString('query', true).trim();
    await interaction.deferReply();

    const results = await this.sourceResolver.search(query, { limit: 8 });
    if (results.length === 0) {
      await interaction.editReply('没有找到可播放的 Apple Music/iTunes 预览结果。');
      return;
    }

    const pending = this.storePendingSearch({
      guildId: interaction.guildId,
      textChannelId: interaction.channelId,
      requestedBy: interaction.user.id,
      results
    });

    const select = new StringSelectMenuBuilder()
      .setCustomId(`search:${pending.id}`)
      .setPlaceholder('选择要加入队列的曲目')
      .addOptions(results.slice(0, 8).map((track, index) => {
        return new StringSelectMenuOptionBuilder()
          .setLabel(truncateSelectText(track.title, 100))
          .setDescription(truncateSelectText([track.artist, track.album].filter(Boolean).join(' · ') || 'iTunes preview', 100))
          .setValue(String(index));
      }));

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
    await interaction.editReply({
      content: `搜索结果：**${escapeMarkdownLite(query)}**\n请选择一个预览音频加入队列。`,
      components: [row]
    });
  }

  async handleStringSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    if (!interaction.customId.startsWith('search:')) {
      return;
    }

    const id = interaction.customId.slice('search:'.length);
    const pending = this.pendingSearches.get(id);
    if (!pending || Date.now() - pending.createdAt > pendingSearchTTL) {
      this.pendingSearches.delete(id);
      await interaction.reply({ content: '这个搜索结果已经过期，请重新使用 /search。', ephemeral: true });
      return;
    }

    if (interaction.user.id !== pending.requestedBy) {
      await interaction.reply({ content: '只有发起这次搜索的用户可以选择结果。', ephemeral: true });
      return;
    }

    if (!interaction.guildId || interaction.guildId !== pending.guildId) {
      await interaction.reply({ content: '搜索结果不属于当前服务器。', ephemeral: true });
      return;
    }
    if (await this.rejectSelectIfCoolingDown(interaction, 'enqueue')) return;

    const index = Number(interaction.values[0]);
    const track = pending.results[index];
    if (!Number.isInteger(index) || !track) {
      await interaction.reply({ content: '无效的搜索结果。', ephemeral: true });
      return;
    }

    const member = await interaction.guild?.members.fetch(interaction.user.id);
    const voiceChannel = member?.voice.channel;
    if (!voiceChannel) {
      await interaction.reply({ content: '请先加入一个语音频道，再选择曲目。', ephemeral: true });
      return;
    }
    if (!voiceChannel.joinable) {
      await interaction.reply({ content: '我没有加入该语音频道的权限。', ephemeral: true });
      return;
    }

    if (this.useLavalink()) {
      await interaction.deferUpdate();
      try {
        const result = await this.lavalinkService!.play(
          voiceChannel,
          pending.textChannelId,
          track.playableUrl ?? track.sourceUrl,
          { id: interaction.user.id, username: interaction.user.username }
        );
        this.pendingSearches.delete(id);
        await interaction.editReply({
          content: `已选择并加入 Lavalink 队列：**${escapeMarkdownLite(result.title)}**`,
          components: []
        });
      } catch (error) {
        this.logger.error({ err: error, guildId: interaction.guildId, sourceUrl: track.sourceUrl }, 'lavalink select play failed');
        await interaction.editReply({
          content: formatLavalinkError(error),
          components: []
        });
      }
      return;
    }

    let item: QueueItem;
    try {
      item = this.queueManager.enqueueResolved({
        guildId: pending.guildId,
        textChannelId: pending.textChannelId,
        voiceChannelId: voiceChannel.id,
        requestedBy: interaction.user.id,
        track
      });
    } catch (error) {
      await interaction.reply({ content: formatEnqueueError(error), ephemeral: true });
      return;
    }
    await this.playerManager.ensurePlaying(voiceChannel, pending.textChannelId);

    this.pendingSearches.delete(id);
    await interaction.update({
      content: `已选择并加入队列：**${escapeMarkdownLite(item.title)}**\n请求 ID：${inlineCode(item.requestId)}`,
      components: []
    });
  }

  private async handleQueue(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({ content: '请在服务器内使用 /queue。', ephemeral: true });
      return;
    }

    if (this.useLavalink()) {
      await interaction.reply(this.lavalinkService!.queueText(interaction.guildId));
      return;
    }

    const queue = this.queueManager.getQueue(interaction.guildId);
    const lines = queue.items.slice(0, 10).map((item, index) => {
      return `${index + 1}. ${escapeMarkdownLite(item.title)} <@${item.requestedBy}>`;
    });

    const current = queue.current ? `正在播放：${formatQueueItem(queue.current)}\n` : '';
    await interaction.reply(lines.length > 0
      ? `${current}待播队列：\n${lines.join('\n')}`
      : `${current}队列为空。`);
  }

  private async handleNowPlaying(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({ content: '请在服务器内使用 /nowplaying。', ephemeral: true });
      return;
    }

    if (this.useLavalink()) {
      const current = this.lavalinkService!.nowPlaying(interaction.guildId);
      await interaction.reply(current ? `正在播放：**${escapeMarkdownLite(current)}**` : '当前没有正在播放的曲目。');
      return;
    }

    const current = this.queueManager.nowPlaying(interaction.guildId);
    await interaction.reply(current
      ? `正在播放：${formatQueueItem(current)}${this.playerManager.isPaused(interaction.guildId) ? ' (paused)' : ''}`
      : '当前没有正在播放的曲目。');
  }

  private async handlePause(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await this.requireGuildAndDj(interaction, '/pause'))) return;
    if (this.useLavalink()) {
      const paused = await this.lavalinkService!.pause(interaction.guildId!);
      await interaction.reply(paused ? '已暂停播放。' : '当前没有可暂停的播放。');
      return;
    }
    const paused = this.playerManager.pause(interaction.guildId!);
    await interaction.reply(paused ? '已暂停播放。' : '当前没有可暂停的播放。');
  }

  private async handleResume(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await this.requireGuildAndDj(interaction, '/resume'))) return;
    if (this.useLavalink()) {
      const resumed = await this.lavalinkService!.resume(interaction.guildId!);
      await interaction.reply(resumed ? '已继续播放。' : '当前没有已暂停的播放。');
      return;
    }
    const resumed = this.playerManager.resume(interaction.guildId!);
    await interaction.reply(resumed ? '已继续播放。' : '当前没有已暂停的播放。');
  }

  private async handleVolume(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await this.requireGuildAndDj(interaction, '/volume'))) return;

    const value = interaction.options.getInteger('value', true);
    if (this.useLavalink()) {
      const normalized = await this.lavalinkService!.setVolume(interaction.guildId!, value);
      await interaction.reply(`音量已设置为 **${normalized}%**。`);
      return;
    }
    const normalized = this.playerManager.setVolume(interaction.guildId!, value);
    await interaction.reply(`音量已设置为 **${normalized}%**。`);
  }

  private async handleRepeat(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await this.requireGuildAndDj(interaction, '/repeat'))) return;
    const mode = interaction.options.getString('mode', true) as RepeatMode;
    if (this.useLavalink()) {
      const normalized = await this.lavalinkService!.setRepeatMode(interaction.guildId!, mode);
      this.queueManager.setRepeatMode(interaction.guildId!, normalized);
      await interaction.reply(`循环模式已设置为 **${normalized}**。`);
      return;
    }
    const normalized = this.queueManager.setRepeatMode(interaction.guildId!, mode);
    await interaction.reply(`循环模式已设置为 **${normalized}**。`);
  }

  private async handleShuffle(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await this.requireGuildAndDj(interaction, '/shuffle'))) return;
    if (this.useLavalink()) {
      const count = await this.lavalinkService!.shuffle(interaction.guildId!);
      await interaction.reply(count > 1 ? `已随机打乱 ${count} 首待播曲目。` : '待播队列不足 2 首，无需打乱。');
      return;
    }
    const count = this.queueManager.shuffle(interaction.guildId!);
    await interaction.reply(count > 1 ? `已随机打乱 ${count} 首待播曲目。` : '待播队列不足 2 首，无需打乱。');
  }

  private async handleRemove(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await this.requireGuildAndDj(interaction, '/remove'))) return;

    const position = interaction.options.getInteger('position', true);
    if (this.useLavalink()) {
      const removed = await this.lavalinkService!.remove(interaction.guildId!, position);
      await interaction.reply(removed
        ? `已移除队列第 ${position} 首：**${escapeMarkdownLite(removed)}**`
        : `队列中没有第 ${position} 首。`);
      return;
    }
    const removed = this.queueManager.remove(interaction.guildId!, position);
    await interaction.reply(removed
      ? `已移除队列第 ${position} 首：**${escapeMarkdownLite(removed.title)}**`
      : `队列中没有第 ${position} 首。`);
  }

  private async handleClear(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await this.requireGuildAndDj(interaction, '/clear'))) return;

    if (this.useLavalink()) {
      const count = await this.lavalinkService!.clear(interaction.guildId!);
      await interaction.reply(`已清空待播队列，共移除 ${count} 首。当前播放不受影响。`);
      return;
    }

    const stats = this.queueManager.stats(interaction.guildId!);
    for (let i = stats.queued; i >= 1; i--) {
      this.queueManager.remove(interaction.guildId!, i);
    }
    await interaction.reply(`已清空待播队列，共移除 ${stats.queued} 首。当前播放不受影响。`);
  }

  private async handleSkip(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await this.requireGuildAndDj(interaction, '/skip'))) return;

    if (this.useLavalink()) {
      const skipped = await this.lavalinkService!.skip(interaction.guildId!);
      await interaction.reply(skipped ? '已跳过当前曲目。' : '当前没有正在播放的曲目。');
      return;
    }

    const skipped = this.playerManager.skip(interaction.guildId!);
    await interaction.reply(skipped ? '已跳过当前曲目。' : '当前没有正在播放的曲目。');
  }

  private async handleStop(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await this.requireGuildAndDj(interaction, '/stop'))) return;

    if (this.useLavalink()) {
      const hadPlayer = await this.lavalinkService!.stop(interaction.guildId!);
      this.guessGameManager.stopRound(interaction.guildId!);
      await interaction.reply(hadPlayer ? '已停止播放、断开语音频道并清空队列。' : '当前没有语音播放连接。');
      return;
    }

    const hadPlayer = this.playerManager.stop(interaction.guildId!);
    await interaction.reply(hadPlayer ? '已停止播放、断开语音频道并清空队列。' : '已清空队列。当前没有语音播放连接。');
  }

  private async handleDjRole(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({ content: '请在服务器内使用 /djrole。', ephemeral: true });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: '只有拥有 Manage Server 权限的成员可以设置 DJ role。', ephemeral: true });
      return;
    }

    const role = interaction.options.getRole('role', false);
    const roleId = role?.id;
    this.queueManager.setDjRoleId(interaction.guildId, roleId);
    await interaction.reply(roleId ? `DJ role 已设置为 <@&${roleId}>。` : 'DJ role 已清除，所有成员都可以控制播放。');
  }

  private async handleGuess(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand(true);
    switch (subcommand) {
      case 'start':
        await this.handleGuessStart(interaction);
        return;
      case 'answer':
        await this.handleGuessAnswer(interaction);
        return;
      case 'hint':
        await this.handleGuessHint(interaction);
        return;
      case 'status':
        await this.handleGuessStatus(interaction);
        return;
      case 'reveal':
        await this.handleGuessReveal(interaction);
        return;
      case 'stop':
        await this.handleGuessStop(interaction);
        return;
      default:
        await interaction.reply({ content: '未知猜歌子命令。', ephemeral: true });
    }
  }

  private async handleGuessStart(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await this.requireGuildAndDj(interaction, '/guess start'))) return;
    if (await this.rejectIfCoolingDown(interaction, 'guess-start')) return;

    const guildId = interaction.guildId!;
    if (this.guessGameManager.hasActiveRound(guildId)) {
      await interaction.reply({ content: '当前服务器已经有一轮猜歌正在进行。可以先使用 /guess answer、/guess reveal 或 /guess stop。', ephemeral: true });
      return;
    }

    const member = await interaction.guild?.members.fetch(interaction.user.id);
    const voiceChannel = member?.voice.channel;
    if (!voiceChannel) {
      await interaction.reply({ content: '请先加入一个语音频道，再开始猜歌。', ephemeral: true });
      return;
    }
    if (!voiceChannel.joinable) {
      await interaction.reply({ content: '我没有加入该语音频道的权限。', ephemeral: true });
      return;
    }

    const query = interaction.options.getString('query', true).trim();
    await interaction.deferReply();
    const results = await this.sourceResolver.search(query, { limit: 12 });
    const candidates = results.filter(track => track.playableUrl);
    if (candidates.length === 0) {
      await interaction.editReply('没有找到可用于猜歌的 Apple Music/iTunes 预览音频。');
      return;
    }

    const track = candidates[Math.floor(Math.random() * candidates.length)];
    if (this.useLavalink()) {
      await this.lavalinkService!.stop(guildId).catch(error => {
        this.logger.warn({ err: error, guildId }, 'failed to stop lavalink player before guess round');
      });
    } else {
      this.playerManager.stop(guildId);
    }

    const round = this.guessGameManager.startRound({
      guildId,
      textChannelId: interaction.channelId,
      startedBy: interaction.user.id,
      track
    });

    if (this.useLavalink()) {
      try {
        await this.lavalinkService!.play(
          voiceChannel,
          interaction.channelId,
          track.playableUrl ?? track.sourceUrl,
          { id: interaction.user.id, username: interaction.user.username }
        );
      } catch (error) {
        this.guessGameManager.stopRound(guildId);
        this.logger.error({ err: error, guildId }, 'failed to start lavalink guess playback');
        await interaction.editReply(formatLavalinkError(error));
        return;
      }
    } else {
      this.queueManager.enqueue({
        guildId,
        textChannelId: interaction.channelId,
        voiceChannelId: voiceChannel.id,
        requestedBy: interaction.user.id,
        title: `🎵 猜歌模式 #${round.id.slice(0, 8)}`,
        artist: '???',
        source: track.source,
        sourceUrl: track.sourceUrl,
        playableUrl: track.playableUrl,
        durationMs: track.durationMs
      });
      await this.playerManager.ensurePlaying(voiceChannel, interaction.channelId);
    }

    await interaction.editReply([
      '🎧 **猜歌开始！** 我会播放一段预览音频。',
      `主题：**${escapeMarkdownLite(query)}**`,
      `答题：${inlineCode('/guess answer text:<歌名>')}`,
      `提示：${inlineCode('/guess hint')}`,
      '开始猜吧！'
    ].join('\n'));
  }

  private async handleGuessAnswer(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({ content: '请在服务器内使用 /guess answer。', ephemeral: true });
      return;
    }
    const text = interaction.options.getString('text', true).trim();
    const result = this.guessGameManager.answer(interaction.guildId, text);
    if (result.ok) {
      if (this.useLavalink()) {
        await this.lavalinkService!.stop(interaction.guildId);
      } else {
        this.playerManager.stop(interaction.guildId);
      }
      await interaction.reply(`🎉 <@${interaction.user.id}> 猜对了！答案是：**${escapeMarkdownLite(formatGuessAnswer(result.round.track))}**`);
      return;
    }
    if (result.reason === 'no_round') {
      await interaction.reply({ content: '当前没有进行中的猜歌回合。', ephemeral: true });
      return;
    }
    await interaction.reply({ content: `不对，再试试！已猜次数：${result.round?.answerCount ?? 0}`, ephemeral: true });
  }

  private async handleGuessHint(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({ content: '请在服务器内使用 /guess hint。', ephemeral: true });
      return;
    }
    const hint = this.guessGameManager.buildHint(interaction.guildId);
    await interaction.reply(hint ? `💡 **提示**\n${hint}` : { content: '当前没有进行中的猜歌回合。', ephemeral: true });
  }

  private async handleGuessStatus(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({ content: '请在服务器内使用 /guess status。', ephemeral: true });
      return;
    }
    const round = this.guessGameManager.getRound(interaction.guildId);
    if (!round) {
      await interaction.reply('当前没有进行中的猜歌回合。');
      return;
    }
    await interaction.reply([
      `🎵 猜歌回合：${inlineCode(round.id.slice(0, 8))}`,
      `发起者：<@${round.startedBy}>`,
      `已猜次数：${round.answerCount}`,
      `提示次数：${round.hintCount}`,
      `开始时间：${round.startedAt.toLocaleString()}`
    ].join('\n'));
  }

  private async handleGuessReveal(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await this.requireGuildAndDj(interaction, '/guess reveal'))) return;
    const round = this.guessGameManager.stopRound(interaction.guildId!);
    if (!round) {
      await interaction.reply({ content: '当前没有进行中的猜歌回合。', ephemeral: true });
      return;
    }
    if (this.useLavalink()) {
      await this.lavalinkService!.stop(interaction.guildId!);
    } else {
      this.playerManager.stop(interaction.guildId!);
    }
    await interaction.reply(`揭晓答案：**${escapeMarkdownLite(formatGuessAnswer(round.track))}**`);
  }

  private async handleGuessStop(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await this.requireGuildAndDj(interaction, '/guess stop'))) return;
    const round = this.guessGameManager.stopRound(interaction.guildId!);
    if (this.useLavalink()) {
      await this.lavalinkService!.stop(interaction.guildId!);
    } else {
      this.playerManager.stop(interaction.guildId!);
    }
    await interaction.reply(round ? '已停止当前猜歌回合。' : '当前没有进行中的猜歌回合。');
  }

  private async handleHealth(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({ content: '请在服务器内使用 /health。', ephemeral: true });
      return;
    }

    if (this.useLavalink()) {
      const stats = this.queueManager.stats(interaction.guildId);
      await interaction.reply({
        content: [
          ...this.lavalinkService!.healthText(interaction.guildId),
          `dj_role: ${stats.djRoleId ? `<@&${stats.djRoleId}>` : 'none'}`,
          `cooldown: ${this.options.userCooldownMs}ms`
        ].join('\n'),
        ephemeral: true
      });
      return;
    }

    const stats = this.queueManager.stats(interaction.guildId);
    const connected = this.playerManager.isConnected(interaction.guildId);
    await interaction.reply({
      content: [
        `voice: ${connected ? 'connected' : 'disconnected'}`,
        `current: ${stats.current ? 'yes' : 'no'}`,
        `paused: ${this.playerManager.isPaused(interaction.guildId) ? 'yes' : 'no'}`,
        `queued: ${stats.queued}/${stats.maxQueueSize}`,
        `volume: ${stats.volume}%`,
        `repeat: ${stats.repeatMode}`,
        `dj_role: ${stats.djRoleId ? `<@&${stats.djRoleId}>` : 'none'}`,
        `cooldown: ${this.options.userCooldownMs}ms`
      ].join('\n'),
      ephemeral: true
    });
  }

  private useLavalink(): boolean {
    return this.lavalinkService?.enabled ?? false;
  }

  private async resolveFirstAndEnqueue(interaction: ChatInputCommandInteraction, query: string, voiceChannelId: string) {
    if (!interaction.guildId) {
      throw new Error('guildId is required');
    }
    const results = await this.sourceResolver.search(query, { limit: 1 });
    const track = results[0];
    if (!track) {
      throw new Error(`No playable preview result for query: ${query}`);
    }
    return this.queueManager.enqueueResolved({
      guildId: interaction.guildId,
      textChannelId: interaction.channelId,
      voiceChannelId,
      requestedBy: interaction.user.id,
      track
    });
  }

  private async requireGuildAndDj(interaction: ChatInputCommandInteraction, commandName: string): Promise<boolean> {
    if (!interaction.guildId) {
      await interaction.reply({ content: `请在服务器内使用 ${commandName}。`, ephemeral: true });
      return false;
    }
    if (await this.hasDjPermission(interaction)) {
      return true;
    }
    const stats = this.queueManager.stats(interaction.guildId);
    await interaction.reply({
      content: `需要 DJ role ${stats.djRoleId ? `<@&${stats.djRoleId}>` : ''} 或 Manage Server 权限才能执行该操作。`,
      ephemeral: true
    });
    return false;
  }

  private async hasDjPermission(interaction: ChatInputCommandInteraction): Promise<boolean> {
    if (!interaction.guildId) return false;
    const stats = this.queueManager.stats(interaction.guildId);
    if (!stats.djRoleId) return true;
    if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
    const member = await interaction.guild?.members.fetch(interaction.user.id);
    return member?.roles.cache.has(stats.djRoleId) ?? false;
  }

  private storePendingSearch(input: Omit<PendingSearch, 'id' | 'createdAt'>): PendingSearch {
    this.gcPendingSearches();
    const pending: PendingSearch = {
      id: randomUUID(),
      createdAt: Date.now(),
      ...input
    };
    this.pendingSearches.set(pending.id, pending);
    return pending;
  }

  private gcPendingSearches(): void {
    const now = Date.now();
    for (const [id, pending] of this.pendingSearches) {
      if (now - pending.createdAt > pendingSearchTTL) {
        this.pendingSearches.delete(id);
      }
    }
  }

  private async rejectIfCoolingDown(interaction: ChatInputCommandInteraction, bucket: string): Promise<boolean> {
    const remainingMs = this.consumeCooldown(interaction.guildId ?? 'dm', interaction.user.id, bucket);
    if (remainingMs <= 0) return false;
    await interaction.reply({
      content: `操作太快了，请 ${Math.ceil(remainingMs / 1000)} 秒后再试。`,
      ephemeral: true
    });
    return true;
  }

  private async rejectSelectIfCoolingDown(interaction: StringSelectMenuInteraction, bucket: string): Promise<boolean> {
    const remainingMs = this.consumeCooldown(interaction.guildId ?? 'dm', interaction.user.id, bucket);
    if (remainingMs <= 0) return false;
    await interaction.reply({
      content: `操作太快了，请 ${Math.ceil(remainingMs / 1000)} 秒后再试。`,
      ephemeral: true
    });
    return true;
  }

  private consumeCooldown(scope: string, userId: string, bucket: string): number {
    const cooldownMs = this.options.userCooldownMs;
    if (cooldownMs <= 0) return 0;
    const key = `${scope}:${userId}:${bucket}`;
    const now = Date.now();
    const last = this.cooldowns.get(key) ?? 0;
    const remaining = cooldownMs - (now - last);
    if (remaining > 0) {
      return remaining;
    }
    this.cooldowns.set(key, now);
    this.gcCooldowns(now);
    return 0;
  }

  private gcCooldowns(now: number): void {
    const ttl = Math.max(this.options.userCooldownMs, 1) * 4;
    for (const [key, last] of this.cooldowns) {
      if (now - last > ttl) {
        this.cooldowns.delete(key);
      }
    }
  }
}

function formatQueueItem(item: QueueItem): string {
  const duration = item.durationMs ? ` (${formatDuration(item.durationMs)})` : '';
  return `**${escapeMarkdownLite(item.title)}**${duration} · <@${item.requestedBy}>`;
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function escapeMarkdownLite(value: string): string {
  return value.replaceAll('`', '\\`').replaceAll('*', '\\*').replaceAll('_', '\\_');
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function truncateSelectText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function formatLavalinkPlayResult(result: LavalinkPlayResult): string {
  const title = `**${escapeMarkdownLite(result.title)}**`;
  if (result.added > 1) {
    const playlist = result.playlistName ? `播放列表：**${escapeMarkdownLite(result.playlistName)}**\n` : '';
    return `${playlist}已加入 Lavalink 队列：${result.added} 首，第一首 ${title}`;
  }
  return `已加入 Lavalink 队列：${title}`;
}

function formatLavalinkError(error: unknown): string {
  if (error instanceof Error) {
    if (error.message.includes('not connected')) {
      return 'Lavalink 节点还没连接好，请稍后重试；如果一直失败，请检查 lavalink 容器日志。';
    }
    if (error.message.startsWith('No Lavalink tracks found')) {
      return 'Lavalink 没有找到可播放结果，请换一个关键词或直接粘贴音频/视频链接。';
    }
  }
  return 'Lavalink 播放失败，错误已记录。';
}

function formatEnqueueError(error: unknown): string {
  if (error instanceof QueueLimitError) {
    return `当前服务器队列已满，最多允许 ${error.maxQueueSize} 首待播曲目。`;
  }
  if (error instanceof Error && error.message.startsWith('No playable preview result')) {
    return '没有找到可播放的 Apple Music/iTunes 预览结果。';
  }
  return '加入队列失败，错误已记录。';
}
