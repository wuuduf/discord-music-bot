# Discord Music Bot

一个全新的 Discord 点歌 Bot 仓库。当前处于 **Phase 8：yt-dlp 直链主播放路径**。

## 当前能力

- 注册 Discord Slash Commands
- `/ping`
- `/play query:<链接或关键词>`：加入用户所在语音频道并播放
  - `AUDIO_BACKEND=lavalink`：默认先用 **yt-dlp 直链**解析关键词或 YouTube 链接；失败后再走 Lavalink `ytmsearch`，最后用 `scsearch` 兜底
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
LAVALINK_FALLBACK_SEARCH_SOURCE=scsearch

YTDLP_ENABLED=true
YTDLP_FALLBACK_MODE=direct
YTDLP_BIN=yt-dlp
YTDLP_FORMAT=bestaudio[ext=m4a]/bestaudio/best
YTDLP_TIMEOUT_MS=180000
YTDLP_CACHE_DIR=runtime/cache
YTDLP_CACHE_PUBLIC_BASE_URL=http://discord-music-bot:3000
YTDLP_CACHE_HTTP_HOST=0.0.0.0
YTDLP_CACHE_HTTP_PORT=3000
YTDLP_CACHE_MAX_MB=2048
YTDLP_CACHE_TTL_HOURS=72
# YTDLP_CACHE_HTTP_TOKEN=
# YTDLP_COOKIES_PATH=/app/runtime/youtube-cookies.txt
YTDLP_JS_RUNTIMES=node
# YTDLP_EXTRACTOR_ARGS=youtube:player_client=web_music
# YTDLP_REMOTE_COMPONENTS=ejs:github

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

默认已经启用 YouTube OAuth：

```yaml
plugins:
  youtube:
    clients:
      - MUSIC
      - TV
      - WEB
      - WEBEMBEDDED
      - TVHTML5_SIMPLY
    oauth:
      enabled: true
```

首次部署或重启 Lavalink 后，如果 YouTube 要求登录，查看日志：

```bash
docker compose logs -f lavalink
```

日志里会出现 OAuth 授权 URL 和 code。用浏览器打开 URL、输入 code 并授权。授权成功后，日志通常会输出 `refreshToken`。不要公开这个 token。

然后编辑：

```bash
nano lavalink/application.yml
```

把 token 填进注释位置：

```yaml
plugins:
  youtube:
    oauth:
      enabled: true
      refreshToken: "paste your refresh token here"
```

最后重启：

```bash
docker compose restart lavalink discord-music-bot
```

如果仍失败，优先看 Lavalink 日志中的 YouTube 报错。常见原因是 YouTube 风控、区域限制、插件版本需要更新，或该账号/网络被 YouTube 限制。


### 默认播放顺序：yt-dlp 直链优先

默认配置：

```env
YTDLP_ENABLED=true
YTDLP_FALLBACK_MODE=direct
LAVALINK_SEARCH_SOURCE=ytmsearch
LAVALINK_FALLBACK_SEARCH_SOURCE=scsearch
```

含义：`/play` 收到关键词或 YouTube 链接时，Bot 会按顺序尝试：

1. **yt-dlp 直链主路径**：执行 `yt-dlp -g -f "$YTDLP_FORMAT" "ytsearch1:<歌名>"` 解析临时媒体直链，再交给 Lavalink 的 HTTP source 播放。
2. **YouTube Music / Lavalink 搜索兜底**：如果 yt-dlp 解析失败，或 yt-dlp 直链播放失败，再走 `LAVALINK_SEARCH_SOURCE=ytmsearch`。
3. **SoundCloud 兜底**：如果 YouTube Music 仍被风控或不可播放，再走 `LAVALINK_FALLBACK_SEARCH_SOURCE=scsearch`。

`/health` 会显示类似：

```text
play_order: yt-dlp-direct->ytmsearch->scsearch
```

如果要改成下载缓存后播放，把模式改为：

```env
YTDLP_FALLBACK_MODE=cache
```

缓存模式会把文件放到 `YTDLP_CACHE_DIR`，并在 Bot 容器内启动一个只给 Lavalink 访问的 HTTP cache server。默认 Compose 网络内地址是：

```env
YTDLP_CACHE_PUBLIC_BASE_URL=http://discord-music-bot:3000
```

你的服务器硬盘只有 25GB，建议先保持默认 `direct`。如果后面启用 `cache`，可以通过 `YTDLP_CACHE_MAX_MB` 和 `YTDLP_CACHE_TTL_HOURS` 控制清理策略。

如果想临时关闭 yt-dlp 主路径，设置：

```env
YTDLP_ENABLED=false
```

关闭后 `/play` 会回到 Lavalink `ytmsearch -> scsearch` 顺序。


### yt-dlp EJS / YouTube 签名解析

如果日志里出现：

```text
Signature solving failed
n challenge solving failed
Requested format is not available
```

这通常表示 yt-dlp 缺少 YouTube JavaScript challenge solver。Docker 镜像已经安装 `yt-dlp[default]`，并默认设置：

```env
YTDLP_JS_RUNTIMES=node
```

如果你使用旧镜像，需要重新构建：

```bash
docker compose up -d --build
```

如果依旧失败，可以临时允许 yt-dlp 从 GitHub 拉取 EJS 组件：

```env
YTDLP_REMOTE_COMPONENTS=ejs:github
```

## 路线图

见 [`docs/ROADMAP.md`](./docs/ROADMAP.md)。
