import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Logger } from 'pino';

export type YtDlpFallbackMode = 'direct' | 'cache';

export type YtDlpServiceConfig = {
  enabled: boolean;
  mode: YtDlpFallbackMode;
  binary: string;
  format: string;
  timeoutMs: number;
  cacheDir: string;
  cachePublicBaseUrl: string;
  cacheHttpHost: string;
  cacheHttpPort: number;
  cacheHttpToken?: string;
  cacheMaxMb: number;
  cacheTtlHours: number;
  cookiesPath?: string;
  extractorArgs?: string;
};

export type YtDlpResolveResult = {
  title: string;
  playUrl: string;
  mode: YtDlpFallbackMode;
  cachedPath?: string;
  videoId?: string;
};

type YtDlpMetadata = {
  id?: string;
  title?: string;
  webpage_url?: string;
  duration?: number;
  ext?: string;
  entries?: YtDlpMetadata[];
};

type CacheMetadata = {
  id?: string;
  title?: string;
  sourceQuery: string;
  sourceUrl?: string;
  fileName: string;
  sizeBytes: number;
  createdAt: string;
  lastAccessedAt: string;
};

const sidecarExtension = '.json';

export class YtDlpService {
  private server?: Server;

  constructor(
    private readonly config: YtDlpServiceConfig,
    private readonly logger: Logger
  ) {}

  get enabled(): boolean {
    return this.config.enabled;
  }

  get mode(): YtDlpFallbackMode {
    return this.config.mode;
  }

  async start(): Promise<void> {
    if (!this.config.enabled) return;
    await mkdir(this.config.cacheDir, { recursive: true });
    await this.cleanupCache();
    if (this.config.mode === 'cache') {
      await this.startCacheServer();
    }
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>(resolve => this.server?.close(() => resolve()));
    this.server = undefined;
  }

  async resolve(query: string): Promise<YtDlpResolveResult> {
    if (!this.config.enabled) {
      throw new Error('yt-dlp fallback is disabled');
    }
    return this.config.mode === 'cache'
      ? await this.resolveCached(query)
      : await this.resolveDirect(query);
  }

  healthText(): string[] {
    if (!this.config.enabled) return ['ytdlp: disabled'];
    const lines = [
      `ytdlp: enabled`,
      `ytdlp_mode: ${this.config.mode}`,
      `ytdlp_format: ${this.config.format}`
    ];
    if (this.config.mode === 'cache') {
      lines.push(
        `ytdlp_cache: ${this.config.cacheDir}`,
        `ytdlp_cache_limit: ${this.config.cacheMaxMb}MB/${this.config.cacheTtlHours}h`,
        `ytdlp_cache_http: ${this.config.cachePublicBaseUrl}`
      );
    }
    return lines;
  }

  private async resolveDirect(query: string): Promise<YtDlpResolveResult> {
    const target = buildSearchTarget(query);
    const { stdout } = await this.runYtDlp([
      ...this.baseArgs(),
      '-f', this.config.format,
      '-g',
      target
    ]);
    const playUrl = stdout.split('\n').map(line => line.trim()).find(Boolean);
    if (!playUrl) throw new Error('yt-dlp returned no direct media URL');
    return {
      title: `yt-dlp: ${query}`,
      playUrl,
      mode: 'direct'
    };
  }

  private async resolveCached(query: string): Promise<YtDlpResolveResult> {
    const target = buildSearchTarget(query);
    const metadata = await this.fetchMetadata(target).catch(error => {
      this.logger.warn({ err: error, query }, 'yt-dlp metadata extraction failed; continuing with download');
      return undefined;
    });

    const existing = metadata?.id ? await this.findCachedFile(metadata.id) : undefined;
    if (existing) {
      await this.touchCacheMetadata(existing, query, metadata);
      return {
        title: metadata?.title ?? path.basename(existing),
        playUrl: this.buildCacheUrl(path.basename(existing)),
        mode: 'cache',
        cachedPath: existing,
        videoId: metadata?.id
      };
    }

    const downloadedPath = await this.downloadToCache(target, metadata?.id);
    const downloadedStat = await stat(downloadedPath);
    const title = metadata?.title ?? path.basename(downloadedPath);
    await this.writeCacheMetadata(downloadedPath, {
      id: metadata?.id ?? inferIdFromFileName(downloadedPath),
      title,
      sourceQuery: query,
      sourceUrl: metadata?.webpage_url,
      fileName: path.basename(downloadedPath),
      sizeBytes: downloadedStat.size,
      createdAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString()
    });
    await this.cleanupCache();

    return {
      title,
      playUrl: this.buildCacheUrl(path.basename(downloadedPath)),
      mode: 'cache',
      cachedPath: downloadedPath,
      videoId: metadata?.id
    };
  }

  private async fetchMetadata(target: string): Promise<YtDlpMetadata> {
    const { stdout } = await this.runYtDlp([
      ...this.baseArgs(),
      '--dump-single-json',
      '--skip-download',
      target
    ]);
    const lines = stdout.trim().split('\n').filter(Boolean);
    const raw = lines.at(-1);
    if (!raw) throw new Error('yt-dlp returned empty metadata');
    const parsed = JSON.parse(raw) as YtDlpMetadata;
    return parsed.entries?.find(entry => entry?.id || entry?.title) ?? parsed;
  }

  private async downloadToCache(target: string, preferredId?: string): Promise<string> {
    await mkdir(this.config.cacheDir, { recursive: true });
    const outputTemplate = path.join(this.config.cacheDir, '%(id)s.%(ext)s');
    const { stdout } = await this.runYtDlp([
      ...this.baseArgs(),
      '-f', this.config.format,
      '-o', outputTemplate,
      '--print', 'after_move:filepath',
      target
    ]);

    const printedPath = stdout.split('\n')
      .map(line => line.trim())
      .reverse()
      .find(line => line && !line.startsWith('['));
    const candidate = printedPath ? path.resolve(printedPath) : undefined;
    if (candidate && await fileExists(candidate) && this.isInsideCache(candidate)) {
      return candidate;
    }

    if (preferredId) {
      const existing = await this.findCachedFile(preferredId);
      if (existing) return existing;
    }

    throw new Error('yt-dlp did not produce a cache file');
  }

  private baseArgs(): string[] {
    const args = [
      '--no-playlist',
      '--no-warnings',
      '--quiet'
    ];
    if (this.config.cookiesPath) {
      args.push('--cookies', this.config.cookiesPath);
    }
    if (this.config.extractorArgs) {
      args.push('--extractor-args', this.config.extractorArgs);
    }
    return args;
  }

  private async runYtDlp(args: string[]): Promise<{ stdout: string; stderr: string }> {
    this.logger.debug({ binary: this.config.binary, args }, 'running yt-dlp');
    return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(this.config.binary, args, {
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`yt-dlp timed out after ${this.config.timeoutMs}ms`));
      }, this.config.timeoutMs);

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        stdout += chunk;
        if (stdout.length > 10_000_000) stdout = stdout.slice(-10_000_000);
      });
      child.stderr.on('data', chunk => {
        stderr += chunk;
        if (stderr.length > 2_000_000) stderr = stderr.slice(-2_000_000);
      });
      child.on('error', error => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      });
      child.on('close', code => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        reject(new Error(`yt-dlp failed with exit code ${code}: ${stderr.trim() || stdout.trim()}`));
      });
    });
  }

  private async startCacheServer(): Promise<void> {
    if (this.server) return;
    this.server = createServer((request, response) => {
      void this.handleCacheRequest(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(this.config.cacheHttpPort, this.config.cacheHttpHost, () => {
        this.server?.off('error', reject);
        resolve();
      });
    });
    this.logger.info({ host: this.config.cacheHttpHost, port: this.config.cacheHttpPort }, 'yt-dlp cache http server ready');
  }

  private async handleCacheRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!request.url) {
        sendText(response, 400, 'missing url');
        return;
      }
      const parsed = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
      if (parsed.pathname === '/healthz') {
        sendText(response, 200, 'ok');
        return;
      }
      if (!parsed.pathname.startsWith('/cache/')) {
        sendText(response, 404, 'not found');
        return;
      }
      if (this.config.cacheHttpToken && parsed.searchParams.get('token') !== this.config.cacheHttpToken) {
        sendText(response, 403, 'forbidden');
        return;
      }

      const encodedName = parsed.pathname.slice('/cache/'.length);
      const fileName = decodeURIComponent(encodedName);
      if (!isSafeCacheFileName(fileName)) {
        sendText(response, 400, 'bad file name');
        return;
      }

      const filePath = path.resolve(this.config.cacheDir, fileName);
      if (!this.isInsideCache(filePath)) {
        sendText(response, 403, 'forbidden');
        return;
      }

      const fileStat = await stat(filePath).catch(() => undefined);
      if (!fileStat?.isFile()) {
        sendText(response, 404, 'not found');
        return;
      }

      await this.touchCacheMetadata(filePath);
      serveFile(request, response, filePath, fileStat.size);
    } catch (error) {
      this.logger.warn({ err: error, url: request.url }, 'cache http request failed');
      if (!response.headersSent) sendText(response, 500, 'internal error');
      else response.destroy();
    }
  }

  private buildCacheUrl(fileName: string): string {
    const base = this.config.cachePublicBaseUrl.replace(/\/$/, '');
    const url = new URL(`${base}/cache/${encodeURIComponent(fileName)}`);
    if (this.config.cacheHttpToken) {
      url.searchParams.set('token', this.config.cacheHttpToken);
    }
    return url.toString();
  }

  private async findCachedFile(videoId: string): Promise<string | undefined> {
    const safeId = sanitizeId(videoId);
    if (!safeId) return undefined;
    const entries = await readdir(this.config.cacheDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name.endsWith(sidecarExtension)) continue;
      if (entry.name === safeId || entry.name.startsWith(`${safeId}.`)) {
        return path.resolve(this.config.cacheDir, entry.name);
      }
    }
    return undefined;
  }

  private async writeCacheMetadata(filePath: string, metadata: CacheMetadata): Promise<void> {
    await writeFile(this.sidecarPath(filePath), JSON.stringify(metadata, null, 2), 'utf8').catch(error => {
      this.logger.warn({ err: error, filePath }, 'failed to write yt-dlp cache metadata');
    });
  }

  private async touchCacheMetadata(filePath: string, sourceQuery?: string, metadata?: YtDlpMetadata): Promise<void> {
    const sidecar = this.sidecarPath(filePath);
    const now = new Date().toISOString();
    const fileStat = await stat(filePath).catch(() => undefined);
    let current: CacheMetadata | undefined;
    try {
      current = JSON.parse(await readFile(sidecar, 'utf8')) as CacheMetadata;
    } catch {
      current = undefined;
    }
    await this.writeCacheMetadata(filePath, {
      id: current?.id ?? metadata?.id ?? inferIdFromFileName(filePath),
      title: current?.title ?? metadata?.title,
      sourceQuery: current?.sourceQuery ?? sourceQuery ?? '',
      sourceUrl: current?.sourceUrl ?? metadata?.webpage_url,
      fileName: path.basename(filePath),
      sizeBytes: fileStat?.size ?? current?.sizeBytes ?? 0,
      createdAt: current?.createdAt ?? now,
      lastAccessedAt: now
    });
  }

  private sidecarPath(filePath: string): string {
    return `${filePath}${sidecarExtension}`;
  }

  private isInsideCache(filePath: string): boolean {
    const relative = path.relative(path.resolve(this.config.cacheDir), path.resolve(filePath));
    return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
  }

  private async cleanupCache(): Promise<void> {
    if (!this.config.enabled || this.config.mode !== 'cache') return;
    await mkdir(this.config.cacheDir, { recursive: true });
    const now = Date.now();
    const ttlMs = Math.max(1, this.config.cacheTtlHours) * 60 * 60 * 1000;
    const maxBytes = Math.max(1, this.config.cacheMaxMb) * 1024 * 1024;
    const files = [] as Array<{ path: string; sidecar: string; size: number; lastAccessedAt: number }>;

    for (const entry of await readdir(this.config.cacheDir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile() || entry.name.endsWith(sidecarExtension)) continue;
      const filePath = path.resolve(this.config.cacheDir, entry.name);
      const fileStat = await stat(filePath).catch(() => undefined);
      if (!fileStat?.isFile()) continue;
      const sidecar = this.sidecarPath(filePath);
      let lastAccessedAt = fileStat.mtimeMs;
      try {
        const metadata = JSON.parse(await readFile(sidecar, 'utf8')) as CacheMetadata;
        lastAccessedAt = Date.parse(metadata.lastAccessedAt) || lastAccessedAt;
      } catch {
        // Sidecar is optional; fall back to mtime.
      }
      files.push({ path: filePath, sidecar, size: fileStat.size, lastAccessedAt });
    }

    for (const file of [...files]) {
      if (now - file.lastAccessedAt > ttlMs) {
        await this.removeCacheFile(file);
      }
    }

    const remaining = files
      .filter(file => now - file.lastAccessedAt <= ttlMs)
      .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
    let total = remaining.reduce((sum, file) => sum + file.size, 0);
    for (const file of remaining) {
      if (total <= maxBytes) break;
      await this.removeCacheFile(file);
      total -= file.size;
    }
  }

  private async removeCacheFile(file: { path: string; sidecar: string; size: number; lastAccessedAt: number }): Promise<void> {
    await rm(file.path, { force: true }).catch(() => undefined);
    await rm(file.sidecar, { force: true }).catch(() => undefined);
    this.logger.info({ file: file.path, size: file.size }, 'removed yt-dlp cache file');
  }
}

function buildSearchTarget(query: string): string {
  if (isHttpUrl(query)) return query;
  return `ytsearch1:${query}`;
}

function sanitizeId(value: string): string | undefined {
  const trimmed = value.trim();
  return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : undefined;
}

function inferIdFromFileName(filePath: string): string | undefined {
  return sanitizeId(path.basename(filePath).split('.')[0] ?? '');
}

function isSafeCacheFileName(fileName: string): boolean {
  return Boolean(fileName)
    && !fileName.includes('/')
    && !fileName.includes('\\')
    && !fileName.startsWith('.')
    && !fileName.endsWith(sidecarExtension)
    && /^[^\0]+$/.test(fileName);
}

async function fileExists(filePath: string): Promise<boolean> {
  const fileStat = await stat(filePath).catch(() => undefined);
  return Boolean(fileStat?.isFile());
}

function serveFile(request: IncomingMessage, response: ServerResponse, filePath: string, size: number): void {
  const range = request.headers.range;
  response.setHeader('Accept-Ranges', 'bytes');
  response.setHeader('Content-Type', contentTypeFor(filePath));
  response.setHeader('Cache-Control', 'private, max-age=3600');

  if (range) {
    const parsed = parseRange(range, size);
    if (!parsed) {
      response.writeHead(416, { 'Content-Range': `bytes */${size}` });
      response.end();
      return;
    }
    const { start, end } = parsed;
    response.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': end - start + 1
    });
    createReadStream(filePath, { start, end }).pipe(response);
    return;
  }

  response.writeHead(200, { 'Content-Length': size });
  createReadStream(filePath).pipe(response);
}

function parseRange(range: string, size: number): { start: number; end: number } | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match) return undefined;
  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : size - 1;
  if (!match[1] && match[2]) {
    const suffixLength = Number(match[2]);
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) {
    return undefined;
  }
  return { start, end: Math.min(end, size - 1) };
}

function sendText(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end(text);
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.m4a' || ext === '.mp4') return 'audio/mp4';
  if (ext === '.webm') return 'audio/webm';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.opus') return 'audio/ogg';
  if (ext === '.ogg') return 'audio/ogg';
  if (ext === '.flac') return 'audio/flac';
  return 'application/octet-stream';
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
