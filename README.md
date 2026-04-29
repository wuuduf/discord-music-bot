# Discord Music Bot

一个全新的 Discord 点歌 Bot 仓库。当前处于 **Phase 7：Lavalink 完整音源后端**。

## 当前能力

- 注册 Discord Slash Commands
- `/ping`
- `/play query:<链接或关键词>`：加入用户所在语音频道并播放
  - `AUDIO_BACKEND=lavalink`：通过 Lavalink 搜索/播放，默认 `ytmsearch`
  - `AUDIO_BACKEND=builtin`：使用内置 `@discordjs/voice` 播放直接音频 URL 或 iTunes 预览
- `/search query:<关键词>`：搜索 Apple Music/iTunes 预览，返回 Select Menu，点击后加入队列播放
- `/queue`、`/nowplaying`
- `/pause` / `/resume`
- `/volume value:<0-100>`
- `/repeat mode:<off|one|all>`
- `/shuffle`
- `/remove position:<序号>`
- `/clear`
- `/skip`
- `/stop`
- `/djrole role:<role>`：设置控制播放所需的 DJ role；不传 role 则清除
- `/health`：查看播放后端、语音连接、队列、音量、循环模式、DJ role 和限流状态
- `/guess start query:<关键词>`：猜歌模式，从 iTunes 预览里随机选一首播放并隐藏答案
- `/guess answer|hint|status|reveal|stop`
- SQLite 持久化：guild 设置、队列项、iTunes 搜索缓存
- Dockerfile / Docker Compose / GitHub Actions CI

> 说明：iTunes Search API 只能提供 `previewUrl` 短预览音频，不是 Apple Music 完整歌曲。完整点歌体验请使用 `AUDIO_BACKEND=lavalink`。

## 快速开始：Docker + Lavalink

```bash
cp .env.example .env
# 编辑 .env：填入 DISCORD_TOKEN、DISCORD_CLIENT_ID、可选 DISCORD_GUILD_ID
npm install
npm run commands:deploy

docker compose up -d --build
```

Docker Compose 会同时启动：

- `lavalink`：音频搜索/播放节点
- `discord-music-bot`：Discord Bot 主进程

查看日志：

```bash
docker compose logs -f lavalink
docker compose logs -f discord-music-bot
```

## 本地开发

```bash
cp .env.example .env
npm install
npm run commands:deploy
npm run dev
```

如果你没有本地 Lavalink，可以临时改为：

```env
AUDIO_BACKEND=builtin
```

此模式只能播放直接音频 URL 或 iTunes 30 秒左右预览。

## `.env` 配置

```env
DISCORD_TOKEN=your_bot_token
DISCORD_CLIENT_ID=your_application_id
DISCORD_GUILD_ID=your_test_guild_id
LOG_LEVEL=info

AUDIO_BACKEND=lavalink
LAVALINK_HOST=lavalink
LAVALINK_PORT=2333
LAVALINK_PASSWORD=youshallnotpass
LAVALINK_SECURE=false
LAVALINK_SEARCH_SOURCE=ytmsearch

ITUNES_COUNTRY=us
STORAGE_PATH=runtime/bot.sqlite
MAX_QUEUE_SIZE=50
USER_COOLDOWN_MS=3000
```

开发时建议设置 `DISCORD_GUILD_ID`，guild commands 更新更快。

## Discord 邀请权限

Bot 邀请 URL 需要包含 scopes：

- `applications.commands`
- `bot`

Bot permissions 至少需要：

- `View Channel`
- `Connect`
- `Speak`
- `Use Voice Activity`

## 测试命令

```text
/play query:Daft Punk One More Time
/queue
/nowplaying
/pause
/resume
/volume value:80
/repeat mode:all
/shuffle
/skip
/stop
```

猜歌模式：

```text
/guess start query:Taylor Swift
/guess answer text:Blank Space
/guess hint
/guess reveal
```

## 脚本

```bash
npm run commands:deploy  # 注册 slash commands
npm run dev              # 本地开发启动
npm run typecheck        # TypeScript 类型检查
npm run build            # 编译到 dist/
```

## Docker 部署到服务器

```bash
git clone <your-repo-url>
cd discord-music-bot
cp .env.example .env
nano .env
npm ci
npm run commands:deploy
docker compose up -d --build
```

数据默认挂载到：

```text
./runtime:/app/runtime
```

默认 SQLite 文件：

```text
runtime/bot.sqlite
```

## Lavalink 配置

配置文件在：

```text
lavalink/application.yml
```

当前配置使用 Lavalink v4 + `dev.lavalink.youtube:youtube-plugin:1.18.0`，并禁用 Lavalink 内置 YouTube source，改用 YouTube Source 插件。

如果 YouTube 解析失败，优先检查：

```bash
docker compose logs -f lavalink
```

常见原因是 YouTube 风控、区域限制或插件版本需要更新。

## 路线图

见 [`docs/ROADMAP.md`](./docs/ROADMAP.md)。
