# Discord 点歌 Bot 分阶段路线

## Phase 1：仓库基础与 Discord App 骨架 ✅ 已完成

目标：能启动 Bot、注册 slash commands、响应 `/ping`，并把 `/play` 请求放入内存队列。

范围：

- TypeScript + Node.js 项目骨架
- 环境变量校验
- 日志
- Discord Client
- Slash command 注册脚本
- `/ping` `/play` `/queue` `/skip` `/stop`
- 内存 QueueManager

验收：

- `npm run typecheck` 通过
- `npm run build` 通过
- 配置 `.env` 后可以执行 `npm run commands:deploy` 和 `npm run dev`

## Phase 2：Discord Voice 播放链路 ✅ 已完成

目标：Bot 加入用户语音频道并播放测试音频 URL。

范围：

- PlayerManager
- guild voice connection 生命周期
- audio player idle/error 处理
- `/skip` `/stop` 真实生效
- 播放完成自动播放下一首

验收：

- `/play <test-audio-url>` 可以进入语音频道播放
- `/skip` 能切到下一首
- `/stop` 能停止并断开

当前说明：

- 已接入 `@discordjs/voice`
- 已加入 `ffmpeg-static`、`opusscript`、`libsodium-wrappers`
- 目前只支持直接 `http(s)` 音频 URL；关键词搜索留给 Phase 3

## Phase 3：搜索与选择 UI ✅ 已完成

目标：支持关键词搜索，返回可选择的歌曲列表。

范围：

- SourceResolver 接口
- Apple Music metadata/search resolver
- Select Menu 选择结果
- 查询结果分页/过期清理

验收：

- `/search query:<keyword>` 返回候选列表
- 点击候选后加入队列

当前说明：

- 已抽象 `SourceResolver`
- 已实现 `ITunesResolver`
- `/search` 使用 Discord Select Menu
- `/play <keyword>` 会搜索并使用第一个可播放预览结果
- 播放源为 iTunes `previewUrl`，不是完整 Apple Music 音频

## Phase 4：持久化与恢复 ✅ 已完成

目标：重启后保留 guild 设置、缓存和可恢复任务状态。

范围：

- SQLite/Postgres schema
- guild_settings
- queue_items
- track_cache
- 启动时清理 stale playing 状态

验收：

- 设置和缓存可跨重启保存
- 崩溃后不会重复播放已完成任务

当前说明：

- 已使用 Node `node:sqlite` 的 `DatabaseSync`
- 默认数据库文件为 `runtime/bot.sqlite`
- 已创建 `guild_settings`、`queue_items`、`track_cache`
- 入队、播放中、完成、清空队列都会写入 `queue_items.status`
- 启动时 stale `playing` 会重置为 `queued`
- iTunes 搜索结果会写入 `track_cache`

## Phase 5：生产化治理 ✅ 已完成

目标：让 Bot 能长期运行。

范围：

- per guild queue limit
- per user cooldown
- 资源清理
- metrics
- reconnect/backoff
- Dockerfile / compose
- CI

验收：

- 长时间运行无明显资源泄露
- 日志能定位失败命令、音源解析失败和 voice 断连

当前说明：

- 已加入 `MAX_QUEUE_SIZE`，默认每服务器 50 首待播
- 已加入 `USER_COOLDOWN_MS`，默认用户操作冷却 3000ms
- 已实现 `/volume`、`/remove`、`/clear`、`/health`
- 已补充 Dockerfile、`.dockerignore`、`docker-compose.yml`
- 已补充 GitHub Actions CI：`npm ci`、`typecheck`、`build`

## Phase 6：高级功能 ✅ 已完成

目标：接近完整点歌产品。

范围：

- playlist 展开
- repeat/shuffle
- DJ role 权限
- Web dashboard，可选
- Lavalink 后端，可选
- 对象存储缓存，可选

当前说明：

- 已实现 `/pause`、`/resume`、`/nowplaying`
- 已实现 `/repeat mode:<off|one|all>`，并持久化到 `guild_settings.repeat_mode`
- 已实现 `/shuffle`，并刷新 SQLite 队列顺序
- 已实现 `/djrole`，并持久化到 `guild_settings.dj_role_id`
- 设置 DJ role 后，`pause/resume/volume/repeat/shuffle/remove/clear/skip/stop` 需要 DJ role 或 Manage Server 权限

## Phase 7：Lavalink 完整音源后端 ✅ 已完成

目标：把 `/play` 从“短预览音频”升级为可搜索完整音源的后端。

范围：

- 接入 `lavalink-client`
- 增加 `AUDIO_BACKEND=builtin|lavalink` 后端切换
- Docker Compose 增加 Lavalink 服务
- Lavalink v4 配置文件
- YouTube Source 插件配置
- `/play`、`/queue`、`/nowplaying`、`/pause`、`/resume`、`/volume`、`/repeat`、`/shuffle`、`/remove`、`/clear`、`/skip`、`/stop` 在 Lavalink 模式下转发到 Lavalink
- 猜歌模式在 Lavalink 模式下仍使用 iTunes 预览作为题目音频

当前说明：

- 默认示例配置使用 `AUDIO_BACKEND=lavalink`
- 默认搜索源为 `ytmsearch`
- `/search` 仍用于 Apple Music/iTunes 预览选择；选择后也可交给 Lavalink 播放
- Lavalink 的可用音源取决于 `lavalink/application.yml` 中启用的 source/plugin 和远端站点可用性

## 猜歌模式扩展 ✅ 已完成

目标：在现有音乐播放基础上增加轻量游戏玩法。

当前说明：

- 已新增 `/guess start query:<关键词>`，从 iTunes/Apple Music 预览搜索结果中随机选择一首播放
- 播放时隐藏真实歌名，队列中只显示猜歌回合编号
- 已新增 `/guess answer text:<歌名>`，支持标准化匹配和少量拼写误差
- 已新增 `/guess hint`，按次数逐步揭示歌名/歌手掩码
- 已新增 `/guess status`、`/guess reveal`、`/guess stop`
- `/guess start|reveal|stop` 复用 DJ role 权限规则


## Phase 8：yt-dlp fallback ✅ 已完成

目标：当 Lavalink YouTube Source 能搜索但被 YouTube 风控拦截播放时，用 yt-dlp 兜底解析。

范围：

- 新增 `YtDlpService`
- 默认 `YTDLP_FALLBACK_MODE=direct`，用 `yt-dlp -g` 解析临时媒体直链
- 保留 `YTDLP_FALLBACK_MODE=cache`，可下载到 `runtime/cache` 后通过内置 HTTP cache server 交给 Lavalink 播放
- Docker runtime 镜像内安装 `yt-dlp` 与 `ffmpeg`
- YouTube 播放失败时 fallback 顺序：yt-dlp 直链/缓存 → SoundCloud
- `/health` 显示 yt-dlp fallback 状态

当前说明：

- 默认推荐直链模式，少占磁盘，适合 25GB 小硬盘服务器
- 缓存模式需要关注 `YTDLP_CACHE_MAX_MB` 与 `YTDLP_CACHE_TTL_HOURS`
