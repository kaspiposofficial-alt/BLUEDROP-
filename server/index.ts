/**
 * Runtime HTTP & API Server (`server/index.ts`)
 *
 * Serves:
 * - `GET  /api/health`         -> Server, active dataset & model health check
 * - `GET  /api/ask?q=`         -> Query-string convenience wrapper for `/api/ask`
 * - `POST /api/ask`            -> Question -> `AskQueryDSL` -> `executeAskQuery` -> `AskQueryResult`
 * - `POST /api/dataset/active` -> Updates active in-memory `Transaction[]` for BYO datasets
 * - `POST /api/ingest/enrich`  -> Tier 2 Gemini structured ingestion enrichment
 * - `POST /api/agent/analyze`  -> Tier 3 Managed Agent (`/v1beta/interactions` + Python `code_execution`) audit
 * - `GET  /api/drive/folder`   -> Google Drive folder / Google Sheet listing
 * - `POST /api/drive/fetch`    -> Google Drive file / Google Sheet content fetcher
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type {
  AiMediaRequest,
  AskQueryDSL,
  IngestEnrichRequest,
  MahsoodaKnowledgeCard,
  RawIngestFile,
  RawSourceRow,
  TargetFormatId,
  Transaction,
} from '../contracts/index.js';
import { buildMockDataset } from '../data/mock/index.js';
import {
  applyGeminiEnrichmentToBundle,
  ingestFilesDeterministically,
} from '../pipeline/ingest-business.js';
import { executeAskQuery } from '../src/ask/executor.js';
import { validateAskQueryDSL } from '../src/ask/validator.js';
import { loadServerConfig, resolveRuntimeApiKey, type ServerConfig } from './config.js';
import { fetchDriveFileContent, listDriveFolder } from './drive.js';
import { enrichDatasetWithGemini, translateQuestionToDSL } from './gemini.js';
import {
  getLearnedVaultSummary,
  handleAiMediaAction,
  ingestMahsoodaKnowledge,
} from './mahsooda.js';
import { runManagedAgentAudit } from './managed-agent.js';
import {
  downloadRemoteBuffer,
  fetchLyricsFromLrclib,
  formatIdToExtension,
  inspectMediaUrl,
  isSafeExternalHttpUrl,
  runFfmpegFileToTempFile,
  runFfmpegStreamToTempFile,
  searchMedia,
} from './media.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(APP_ROOT, 'dist');
const CAPTURE_DIR = path.join(APP_ROOT, 'capture');
const TRANSACTIONS_JSON_PATH = path.join(APP_ROOT, 'data', 'transactions.json');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ico': 'image/x-icon',
};

/**
 * Load real 2025 `Transaction[]` from `data/transactions.json`, falling back
 * to `buildMockDataset().transactions` only if `data/transactions.json` is absent.
 */
export function loadRealOrFallbackTransactions(): Transaction[] {
  if (fs.existsSync(TRANSACTIONS_JSON_PATH)) {
    try {
      const raw = fs.readFileSync(TRANSACTIONS_JSON_PATH, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed as Transaction[];
      }
    } catch {
      // Fall through to mock dataset
    }
  }
  return buildMockDataset().transactions;
}

function buildCorsHeaders(req?: http.IncomingMessage): Record<string, string> {
  const origin = req?.headers?.origin;
  if (origin && typeof origin === 'string') {
    try {
      const parsed = new URL(origin);
      const h = parsed.hostname.toLowerCase();
      const appUrl = (process.env.APP_URL || '').trim();
      let allowed =
        parsed.protocol === 'https:' &&
        (h === 'ai.studio' || h.endsWith('.ai.studio') || h === 'aistudio.google.com');
      if (!allowed && appUrl) {
        try {
          allowed = parsed.origin === new URL(appUrl).origin;
        } catch {
          // Ignore invalid APP_URL
        }
      }
      if (allowed) {
        return {
          'Access-Control-Allow-Origin': origin,
          'Vary': 'Origin',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        };
      }
    } catch {
      // Ignore invalid Origin header
    }
  }
  return {};
}

export function sendJson(res: http.ServerResponse, statusCode: number, body: unknown, req?: http.IncomingMessage): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    ...buildCorsHeaders(req),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

async function writeStreamToTempFile(
  req: http.IncomingMessage,
  inputExt: string,
  maxBytes = 2 * 1024 * 1024 * 1024
): Promise<{ tmpDir: string; inputPath: string; totalBytes: number; cleanup: () => Promise<void> }> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bluedrop-up-'));
  const cleanExt = inputExt.replace(/[^a-z0-9]/gi, '').slice(0, 6) || 'bin';
  const inputPath = path.join(tmpDir, `input.${cleanExt}`);
  const cleanup = async (): Promise<void> => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  };

  try {
    let totalBytes = 0;
    await new Promise<void>((resolve, reject) => {
      const ws = fs.createWriteStream(inputPath);
      req.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          req.destroy();
          ws.destroy(new Error('Uploaded media exceeds 2GB stream limit.'));
        }
      });
      req.on('error', (err) => {
        ws.destroy();
        reject(err);
      });
      ws.on('error', reject);
      ws.on('finish', resolve);
      req.pipe(ws);
    });
    return { tmpDir, inputPath, totalBytes, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > 35 * 1024 * 1024) {
        reject(new Error('Request body too large (exceeds 35MB limit).'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        if (!raw) {
          resolve({});
          return;
        }
        const parsed = JSON.parse(raw) as unknown;
        if (typeof parsed === 'object' && parsed !== null) {
          resolve(parsed as Record<string, unknown>);
        } else {
          resolve({});
        }
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function extractAccessToken(
  req: http.IncomingMessage,
  parsedUrl: URL,
  body?: Record<string, unknown>
): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const tok = auth.slice('Bearer '.length).trim();
    if (tok) return tok;
  }
  // Query-string accessToken intentionally disallowed to prevent token leakage in request logs.
  if (typeof body?.accessToken === 'string' && body.accessToken.trim()) {
    return body.accessToken.trim();
  }
  return undefined;
}

function hydrateIngestEnrichRequest(reqBody: IngestEnrichRequest): {
  hydrated: IngestEnrichRequest;
  baseRows: RawSourceRow[];
  files: RawIngestFile[];
} {
  const files = Array.isArray(reqBody.files) ? reqBody.files : [];
  if (files.length > 0) {
    const baseBundle = ingestFilesDeterministically(files, {
      entityName: reqBody.entity_name_hint,
      isB2B: true,
    });
    const baseRows =
      Array.isArray(reqBody.raw_rows) && reqBody.raw_rows.length > 0
        ? reqBody.raw_rows
        : baseBundle.transactions.map((t) => t.source_row);
    const unclassified =
      Array.isArray(reqBody.unclassified_descriptions) &&
      reqBody.unclassified_descriptions.length > 0
        ? reqBody.unclassified_descriptions
        : Array.from(
            new Set(
              baseBundle.transactions
                .filter((t) => t.category_confidence < 0.75)
                .map((t) => t.raw_description)
            )
          ).slice(0, 50);
    const factsSummary =
      Array.isArray(reqBody.facts_summary) && reqBody.facts_summary.length > 0
        ? reqBody.facts_summary
        : baseBundle.facts.map((f) => ({
            id: f.id,
            label: f.label,
            formatted: f.formatted,
            computation: f.computation,
          }));
    const chapterIds =
      Array.isArray(reqBody.chapter_ids) && reqBody.chapter_ids.length > 0
        ? reqBody.chapter_ids
        : [
            'pour',
            'year_as_squares',
            'your_place',
            'studio_session',
            'streak',
            'getaway',
            'rivalry',
            'heartbeat',
            'big_one',
            'subscription_garden',
            'personality',
            'one_line',
            'share_card',
          ];

    return {
      hydrated: {
        ...reqBody,
        raw_rows: baseRows,
        unclassified_descriptions: unclassified,
        facts_summary: factsSummary,
        chapter_ids: chapterIds,
      },
      baseRows,
      files,
    };
  }

  return {
    hydrated: reqBody,
    baseRows: Array.isArray(reqBody.raw_rows) ? reqBody.raw_rows : [],
    files: [],
  };
}

export interface ApiHandlerOptions {
  transactions?: readonly Transaction[];
  config?: ServerConfig;
}

/**
 * Create a reusable HTTP API handler for `/api/*` endpoints.
 * Returns `true` if the request matched an API route and was handled, `false` otherwise.
 */
export function createApiHandler(
  options?: ApiHandlerOptions
): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean> {
  const initialConfig = options?.config ?? loadServerConfig();
  const defaultTransactions: readonly Transaction[] =
    options?.transactions ?? loadRealOrFallbackTransactions();

  function getEffectiveConfig(): ServerConfig {
    if (options?.config !== undefined) {
      return initialConfig;
    }
    const freshKey = resolveRuntimeApiKey();
    if (freshKey && freshKey !== initialConfig.apiKey) {
      return {
        ...initialConfig,
        apiKey: freshKey,
        hasApiKey: true,
      };
    }
    return initialConfig;
  }

  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> => {
    const method = req.method ?? 'GET';
    const parsedUrl = new URL(req.url ?? '/', 'http://localhost');
    const pathname = parsedUrl.pathname;

    if (!pathname.startsWith('/api/')) {
      return false;
    }

    if (method === 'OPTIONS') {
      res.writeHead(204, buildCorsHeaders(req));
      res.end();
      return true;
    }

    const config = getEffectiveConfig();

    // 1. GET /api/health
    if (pathname === '/api/health' && method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        status: 'ok',
        model: config.modelName,
        hasApiKey: config.hasApiKey,
        aiModelName: config.aiModelName,
        hasExternalAiKey: config.hasExternalAiKey,
        ffmpegReady: true,
        transactionCount: defaultTransactions.length,
      });
      return true;
    }

    // M1. GET /api/media/search
    if (pathname === '/api/media/search' && method === 'GET') {
      try {
        const q = (parsedUrl.searchParams.get('q') ?? '').trim();
        const typeParam = parsedUrl.searchParams.get('type');
        const filter =
          typeParam === 'music' || typeParam === 'video' ? typeParam : 'all';
        if (!q) {
          sendJson(res, 400, { error: 'Missing `q` search query parameter.' });
          return true;
        }
        const result = await searchMedia(q, filter);
        sendJson(res, 200, { ok: true, query: q, ...result });
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Media search failed.';
        sendJson(res, 500, { error: message });
        return true;
      }
    }

    // M2. GET / POST /api/media/inspect
    if (pathname === '/api/media/inspect' && (method === 'GET' || method === 'POST')) {
      try {
        const body = method === 'POST' ? await readJsonBody(req) : {};
        const url = (
          parsedUrl.searchParams.get('url') ??
          (typeof body.url === 'string' ? body.url : '')
        ).trim();
        if (!url) {
          sendJson(res, 400, { error: 'Missing `url` parameter.' });
          return true;
        }
        const inspected = await inspectMediaUrl(url);
        if (!inspected.lyricsText && inspected.title && inspected.title.length > 2) {
          const lyrics = await fetchLyricsFromLrclib(inspected.title, inspected.creator).catch(
            () => null
          );
          if (lyrics?.lyricsText) {
            inspected.lyricsText = lyrics.lyricsText;
            inspected.lyricsSynced = lyrics.lyricsSynced;
            inspected.lyricsSource = lyrics.lyricsSource;
          }
        }
        sendJson(res, 200, { ok: true, media: inspected });
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to inspect media URL.';
        sendJson(res, 400, { error: message });
        return true;
      }
    }

    // M2b. GET /api/media/lyrics?title=...&artist=...
    if (pathname === '/api/media/lyrics' && method === 'GET') {
      try {
        const title = (parsedUrl.searchParams.get('title') ?? '').trim();
        const artist = (parsedUrl.searchParams.get('artist') ?? '').trim();
        if (!title) {
          sendJson(res, 400, { error: 'Missing `title` parameter.' });
          return true;
        }
        const lyrics = await fetchLyricsFromLrclib(title, artist || undefined);
        sendJson(res, 200, { ok: true, ...lyrics });
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Lyrics lookup failed.';
        sendJson(res, 500, { error: message });
        return true;
      }
    }

    // M3. GET /api/media/thumb (CORS-safe image proxy for client-side Canvas analysis)
    if (pathname === '/api/media/thumb' && method === 'GET') {
      try {
        const rawUrl = (parsedUrl.searchParams.get('url') ?? '').trim();
        const safeUrl = isSafeExternalHttpUrl(rawUrl);
        if (!safeUrl) {
          sendJson(res, 400, { error: 'Invalid image URL.' });
          return true;
        }
        const remote = await downloadRemoteBuffer(safeUrl.toString());
        if (!remote.contentType.startsWith('image/')) {
          sendJson(res, 400, { error: 'URL did not return an image.' });
          return true;
        }
        res.writeHead(200, {
          'Content-Type': remote.contentType,
          'Cache-Control': 'public, max-age=3600',
          ...buildCorsHeaders(req),
        });
        res.end(remote.buffer);
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Thumbnail proxy failed.';
        sendJson(res, 400, { error: message });
        return true;
      }
    }

    // M3b. GET /api/media/stream (Range-aware same-origin video/audio preview proxy for CORS-blocked CDNs — zero mid-stream timeout)
    if (pathname === '/api/media/stream' && (method === 'GET' || method === 'HEAD')) {
      try {
        req.setTimeout(0);
        res.setTimeout(0);
        const rawUrl = (parsedUrl.searchParams.get('url') ?? '').trim();
        const safeUrl = isSafeExternalHttpUrl(rawUrl);
        if (!safeUrl) {
          sendJson(res, 400, { error: 'Invalid media stream URL.' });
          return true;
        }
        const reqHeaders: Record<string, string> = {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
          Referer: safeUrl.origin + '/',
        };
        if (typeof req.headers.range === 'string' && req.headers.range) {
          reqHeaders.Range = req.headers.range;
        }
        const connectController = new AbortController();
        const connectTimer = setTimeout(() => connectController.abort(), 22000);
        req.on('close', () => connectController.abort());
        let upstream: globalThis.Response;
        try {
          upstream = await fetch(safeUrl.toString(), {
            method: method === 'HEAD' ? 'HEAD' : 'GET',
            headers: reqHeaders,
            signal: connectController.signal,
          });
        } finally {
          clearTimeout(connectTimer);
        }
        if (!upstream.ok && upstream.status !== 206) {
          sendJson(res, 400, { error: `Upstream returned ${upstream.status}` });
          return true;
        }
        const respHeaders: Record<string, string> = {
          'Content-Type':
            upstream.headers.get('content-type')?.split(';')[0] || 'video/mp4',
          'Accept-Ranges': upstream.headers.get('accept-ranges') || 'bytes',
          'Cache-Control': 'public, max-age=600',
          ...buildCorsHeaders(req),
        };
        const cLen = upstream.headers.get('content-length');
        const cRange = upstream.headers.get('content-range');
        if (cLen) respHeaders['Content-Length'] = cLen;
        if (cRange) respHeaders['Content-Range'] = cRange;
        res.writeHead(upstream.status === 206 ? 206 : 200, respHeaders);
        if (method === 'HEAD' || !upstream.body) {
          res.end();
          return true;
        }
        const nodeStream = Readable.fromWeb(
          upstream.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>
        );
        nodeStream.on('error', () => {
          if (!res.writableEnded) res.end();
        });
        req.on('close', () => {
          nodeStream.destroy();
        });
        nodeStream.pipe(res);
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Stream proxy failed.';
        if (!res.headersSent) sendJson(res, 400, { error: message });
        return true;
      }
    }

    // M4. HEAD / GET / POST /api/media/download (Zero-RAM HTTP stream passthrough + FFmpeg direct URL streaming for any duration including 1h+)
    if (
      pathname === '/api/media/download' &&
      (method === 'HEAD' || method === 'GET' || method === 'POST')
    ) {
      let resolvedStreamUrl = '';
      let resolvedDisposition = 'attachment';
      try {
        req.setTimeout(0);
        res.setTimeout(0);
        const body = method === 'POST' ? await readJsonBody(req) : {};
        const streamUrl = (
          parsedUrl.searchParams.get('streamUrl') ??
          (typeof body.streamUrl === 'string' ? body.streamUrl : '')
        ).trim();
        resolvedStreamUrl = streamUrl;
        const formatId = (
          parsedUrl.searchParams.get('format') ??
          (typeof body.format === 'string' ? body.format : 'mp3-320')
        ).trim() as TargetFormatId;
        const title = (
          parsedUrl.searchParams.get('title') ??
          (typeof body.title === 'string' ? body.title : 'bluedrop-media')
        ).trim();
        const artist = (
          parsedUrl.searchParams.get('artist') ??
          (typeof body.artist === 'string' ? body.artist : '')
        ).trim();
        const safeAsciiName =
          title.replace(/[^a-z0-9 _-]+/gi, '_').trim().slice(0, 48) || 'bluedrop-media';
        const safeUtf8Name =
          title.replace(/[^a-z0-9\u0600-\u06FF _-]+/gi, '_').trim().slice(0, 64) || 'bluedrop-media';
        const outExt = formatIdToExtension(formatId);
        const contentDisposition = `attachment; filename="${safeAsciiName}.${outExt}"; filename*=UTF-8''${encodeURIComponent(`${safeUtf8Name}.${outExt}`)}`;
        resolvedDisposition = contentDisposition;

        if (!streamUrl) {
          sendJson(res, 400, { error: 'Missing direct streamUrl for download/conversion.' });
          return true;
        }
        const safeTarget = isSafeExternalHttpUrl(streamUrl);
        if (!safeTarget) {
          sendJson(res, 400, { error: 'Blocked unsafe or invalid streamUrl.' });
          return true;
        }

        // Preflight check for native streaming <a> download
        if (method === 'HEAD') {
          const probeHeaders = {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
            Referer: `${safeTarget.origin}/`,
          };
          let headProbe = await fetch(safeTarget.toString(), {
            method: 'HEAD',
            headers: probeHeaders,
            signal: AbortSignal.timeout(6000),
          }).catch(() => null);
          if (!headProbe || (!headProbe.ok && headProbe.status !== 405 && headProbe.status !== 403)) {
            headProbe = await fetch(safeTarget.toString(), {
              method: 'GET',
              headers: { ...probeHeaders, Range: 'bytes=0-1' },
              signal: AbortSignal.timeout(6000),
            }).catch(() => null);
          }
          const okProbe =
            headProbe &&
            (headProbe.ok ||
              headProbe.status === 206 ||
              headProbe.status === 405 ||
              headProbe.status === 403);
          if (!okProbe && !safeTarget.pathname.toLowerCase().endsWith('.m3u8')) {
            res.writeHead(400, buildCorsHeaders(req));
            res.end();
            return true;
          }
          const headHeaders: Record<string, string> = {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': contentDisposition,
            ...buildCorsHeaders(req),
          };
          const cRange = headProbe?.headers.get('content-range') || '';
          const rangeTotal = cRange.match(/\/(\d+)\s*$/)?.[1];
          const rawLen = rangeTotal || (headProbe?.status === 200 ? headProbe.headers.get('content-length') : null);
          if (rawLen && /^\d+$/.test(rawLen)) {
            headHeaders['Content-Length'] = rawLen;
          }
          res.writeHead(200, headHeaders);
          res.end();
          return true;
        }

        const remotePathLower = safeTarget.pathname.toLowerCase();
        const queryMime = (safeTarget.searchParams.get('mime') ?? '').toLowerCase();
        const isHls = remotePathLower.endsWith('.m3u8');
        const isMp4Source =
          remotePathLower.endsWith('.mp4') ||
          remotePathLower.endsWith('.m4v') ||
          queryMime.includes('video/mp4');
        const isWebmSource =
          remotePathLower.endsWith('.webm') || queryMime.includes('video/webm');
        const isM4aSource =
          remotePathLower.endsWith('.m4a') || queryMime.includes('audio/mp4');
        const isMp3Source =
          remotePathLower.endsWith('.mp3') || queryMime.includes('audio/mpeg');

        const directCompatible =
          !isHls &&
          ((formatId === 'm4a' && isM4aSource) ||
            ((formatId === 'mp4-1080' || formatId === 'mp4-4k' || formatId === 'mp4-720') &&
              isMp4Source) ||
            (formatId === 'webm' && isWebmSource) ||
            ((formatId === 'mp3-320' || formatId === 'mp3-192') && isMp3Source) ||
            (formatId === 'jpg' &&
              (remotePathLower.endsWith('.jpg') || remotePathLower.endsWith('.jpeg'))) ||
            (formatId === 'png' && remotePathLower.endsWith('.png')) ||
            (formatId === 'webp' && remotePathLower.endsWith('.webp')));

        if (directCompatible) {
          const connectController = new AbortController();
          const connectTimer = setTimeout(() => connectController.abort(), 25000);
          req.on('close', () => connectController.abort());
          let upstream: globalThis.Response;
          try {
            upstream = await fetch(safeTarget.toString(), {
              headers: {
                'User-Agent':
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
                Referer: `${safeTarget.origin}/`,
              },
              signal: connectController.signal,
            });
          } finally {
            clearTimeout(connectTimer);
          }
          if (upstream.ok && upstream.body) {
            const cType =
              upstream.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';
            const cLen = upstream.headers.get('content-length');
            const headers: Record<string, string> = {
              'Content-Type': cType,
              'Content-Disposition': contentDisposition,
              ...buildCorsHeaders(req),
            };
            if (cLen) headers['Content-Length'] = cLen;
            res.writeHead(200, headers);
            const nodeStream = Readable.fromWeb(
              upstream.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>
            );
            nodeStream.on('error', () => {
              if (!res.writableEnded) res.end();
            });
            req.on('close', () => {
              nodeStream.destroy();
            });
            nodeStream.pipe(res);
            return true;
          }
        }

        // Stream directly via FFmpeg (-i streamUrl) -> supports 1h-2h+ videos and HLS .m3u8
        const streamed = await runFfmpegStreamToTempFile({
          streamUrl: safeTarget.toString(),
          targetFormat: formatId,
          title,
          artist,
        });

        res.writeHead(200, {
          'Content-Type': streamed.mimeType,
          'Content-Disposition': contentDisposition,
          'Content-Length': String(streamed.sizeBytes),
          ...buildCorsHeaders(req),
        });
        const fileStream = fs.createReadStream(streamed.outputPath);
        fileStream.on('close', () => {
          void streamed.cleanup();
        });
        fileStream.on('error', () => {
          void streamed.cleanup();
          if (!res.writableEnded) res.end();
        });
        req.on('close', () => {
          fileStream.destroy();
          void streamed.cleanup();
        });
        fileStream.pipe(res);
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Download/transcode failed.';
        const noFfmpeg =
          msg.includes('ENOENT') ||
          msg.toLowerCase().includes('spawn ffmpeg');
        if (noFfmpeg && !res.headersSent && resolvedStreamUrl) {
          try {
            const safeTarget = isSafeExternalHttpUrl(resolvedStreamUrl);
            if (safeTarget) {
              const directResp = await fetch(safeTarget.toString(), {
                headers: {
                  'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
                  Referer: `${safeTarget.origin}/`,
                },
                signal: AbortSignal.timeout(20000),
              });
              if (directResp.ok && directResp.body) {
                const cType =
                  directResp.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';
                const cLen = directResp.headers.get('content-length');
                const headers: Record<string, string> = {
                  'Content-Type': cType,
                  'Content-Disposition': resolvedDisposition,
                  ...buildCorsHeaders(req),
                };
                if (cLen) headers['Content-Length'] = cLen;
                res.writeHead(200, headers);
                const nodeStream = Readable.fromWeb(
                  directResp.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>
                );
                nodeStream.on('error', () => {
                  if (!res.writableEnded) res.end();
                });
                nodeStream.pipe(res);
                return true;
              }
            }
          } catch {
            // Fall through to structured error
          }
        }
        if (!res.headersSent) sendJson(res, noFfmpeg ? 501 : 400, { error: msg });
        return true;
      }
    }

    // M5. POST /api/media/convert (Local uploaded file -> Any format via FFmpeg, streamed on disk for 1h+ files)
    if (pathname === '/api/media/convert' && method === 'POST') {
      let uploadCleanup: (() => Promise<void>) | null = null;
      try {
        req.setTimeout(0);
        res.setTimeout(0);
        const targetFormat = (
          (req.headers['x-target-format'] as string | undefined) ??
          parsedUrl.searchParams.get('format') ??
          'mp3-320'
        ).trim() as TargetFormatId;
        const fileName = decodeURIComponent(
          (req.headers['x-file-name'] as string | undefined) ?? 'upload.bin'
        );
        const title = decodeURIComponent(
          (req.headers['x-title'] as string | undefined) ?? fileName.replace(/\.[^.]+$/, '')
        );
        const artist = decodeURIComponent(
          (req.headers['x-artist'] as string | undefined) ?? 'BLUEDROP Studio'
        );
        const inputExt = path.extname(fileName).replace('.', '') || 'bin';
        const uploaded = await writeStreamToTempFile(req, inputExt);
        uploadCleanup = uploaded.cleanup;
        if (uploaded.totalBytes === 0) {
          await uploaded.cleanup();
          sendJson(res, 400, { error: 'Empty file upload.' });
          return true;
        }
        const converted = await runFfmpegFileToTempFile({
          inputPath: uploaded.inputPath,
          targetFormat,
          title,
          artist,
        });
        await uploaded.cleanup();
        uploadCleanup = null;

        const safeAsciiBase =
          title.replace(/[^a-z0-9 _-]+/gi, '_').trim().slice(0, 48) || 'converted';
        const safeUtf8Base =
          title.replace(/[^a-z0-9\u0600-\u06FF _-]+/gi, '_').trim().slice(0, 64) || 'converted';
        res.writeHead(200, {
          'Content-Type': converted.mimeType,
          'Content-Disposition': `attachment; filename="${safeAsciiBase}.${converted.ext}"; filename*=UTF-8''${encodeURIComponent(`${safeUtf8Base}.${converted.ext}`)}`,
          'Content-Length': String(converted.sizeBytes),
          ...buildCorsHeaders(req),
        });
        const outStream = fs.createReadStream(converted.outputPath);
        outStream.on('close', () => {
          void converted.cleanup();
        });
        outStream.on('error', () => {
          void converted.cleanup();
          if (!res.writableEnded) res.end();
        });
        req.on('close', () => {
          outStream.destroy();
          void converted.cleanup();
        });
        outStream.pipe(res);
        return true;
      } catch (err) {
        if (uploadCleanup) await uploadCleanup().catch(() => {});
        const message = err instanceof Error ? err.message : 'FFmpeg conversion failed.';
        const noFfmpeg =
          message.includes('ENOENT') || message.toLowerCase().includes('spawn ffmpeg');
        if (!res.headersSent) {
          sendJson(res, noFfmpeg ? 501 : 400, {
            error: noFfmpeg ? 'Server FFmpeg unavailable; use direct on-device export.' : message,
            code: noFfmpeg ? 'NO_FFMPEG' : 'CONVERT_FAILED',
          });
        }
        return true;
      }
    }

    // M6. POST /api/ai-media (Secure server-side AI proxy for summarize/transcript/translate/separate)
    if (pathname === '/api/ai-media' && method === 'POST') {
      try {
        const body = (await readJsonBody(req)) as unknown as AiMediaRequest;
        if (!body || !body.action || !body.media) {
          sendJson(res, 400, { error: 'Missing `action` or `media` payload.' });
          return true;
        }
        const result = await handleAiMediaAction(body, config);
        sendJson(res, 200, result);
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'AI media request failed.';
        sendJson(res, 500, { error: message });
        return true;
      }
    }

    // M7. GET / POST /api/mahsooda-learn (Silent ~2KB client-distilled knowledge vault)
    if (pathname === '/api/mahsooda-learn' && (method === 'GET' || method === 'POST')) {
      try {
        if (method === 'GET') {
          sendJson(res, 200, { ok: true, ...getLearnedVaultSummary() });
          return true;
        }
        const body = (await readJsonBody(req)) as unknown as MahsoodaKnowledgeCard;
        if (!body || !body.title) {
          sendJson(res, 400, { error: 'Invalid knowledge payload.' });
          return true;
        }
        const outcome = await ingestMahsoodaKnowledge(body, config);
        sendJson(res, 200, { ...outcome, ...getLearnedVaultSummary() });
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Knowledge ingestion failed.';
        sendJson(res, 500, { error: message });
        return true;
      }
    }

    // 2. POST /api/dataset/active
    if (pathname === '/api/dataset/active' && method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const candidateTxns = Array.isArray(body.transactions)
          ? body.transactions
          : typeof body.bundle === 'object' &&
              body.bundle !== null &&
              Array.isArray((body.bundle as Record<string, unknown>).transactions)
            ? ((body.bundle as Record<string, unknown>).transactions as unknown[])
            : null;

        if (!candidateTxns || candidateTxns.length === 0) {
          sendJson(res, 400, { error: 'Expected non-empty `transactions` array.' });
          return true;
        }

        sendJson(res, 200, {
          ok: true,
          transactionCount: candidateTxns.length,
        });
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to update active dataset.';
        sendJson(res, 500, { error: message });
        return true;
      }
    }

    // 3. GET /api/ask & POST /api/ask
    if (pathname === '/api/ask' && (method === 'POST' || method === 'GET')) {
      try {
        let question = '';
        let explicitDsl: AskQueryDSL | undefined;
        let requestTransactions: readonly Transaction[] = defaultTransactions;

        if (method === 'GET') {
          question = (
            parsedUrl.searchParams.get('q') ??
            parsedUrl.searchParams.get('question') ??
            ''
          ).trim();
        } else {
          const body = await readJsonBody(req);
          if (typeof body.question === 'string') {
            question = body.question.trim();
          }
          if (Array.isArray(body.transactions) && body.transactions.length > 0) {
            requestTransactions = body.transactions as Transaction[];
          }
          if (typeof body.query === 'object' && body.query !== null) {
            const validated = validateAskQueryDSL(body.query, question, requestTransactions);
            explicitDsl = validated.query;
          }
        }

        if (!question && !explicitDsl) {
          sendJson(res, 400, {
            error: 'Missing `question` or `query` in request.',
          });
          return true;
        }

        if (explicitDsl) {
          const result = executeAskQuery(explicitDsl, requestTransactions, {
            question: question || explicitDsl.interpretation,
            source: 'builder',
          });
          sendJson(res, 200, result);
          return true;
        }

        const translated = await translateQuestionToDSL(question, config, requestTransactions);
        const result = executeAskQuery(translated.query, requestTransactions, {
          question,
          source: translated.source,
        });
        sendJson(res, 200, result);
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Internal server error';
        sendJson(res, 500, { error: message });
        return true;
      }
    }

    // 4. POST /api/ingest/enrich (Tier 2 Gemini Enrichment)
    if (pathname === '/api/ingest/enrich' && method === 'POST') {
      try {
        const body = (await readJsonBody(req)) as unknown as IngestEnrichRequest;
        const { hydrated, baseRows, files } = hydrateIngestEnrichRequest(body);
        const enrichment = await enrichDatasetWithGemini(hydrated, config);

        const effectiveRows =
          enrichment.extracted_rows && enrichment.extracted_rows.length > 0
            ? enrichment.extracted_rows
            : baseRows;

        if (effectiveRows.length > 0 || files.length > 0) {
          const bundle = applyGeminiEnrichmentToBundle(
            effectiveRows,
            files,
            enrichment,
            body.entity_name_hint
          );
          sendJson(res, 200, {
            ...enrichment,
            bundle,
          });
          return true;
        }

        sendJson(res, 200, enrichment);
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to enrich dataset.';
        sendJson(res, 500, { error: message });
        return true;
      }
    }

    // 5. POST /api/agent/analyze (Tier 3 Managed Agent + Python code_execution Audit)
    if (pathname === '/api/agent/analyze' && method === 'POST') {
      try {
        const body = (await readJsonBody(req)) as unknown as IngestEnrichRequest;
        const { hydrated, baseRows, files } = hydrateIngestEnrichRequest(body);
        const agentResponse = await runManagedAgentAudit(hydrated, config);

        const effectiveRows =
          agentResponse.extracted_rows && agentResponse.extracted_rows.length > 0
            ? agentResponse.extracted_rows
            : baseRows;

        if (effectiveRows.length > 0 || files.length > 0) {
          const bundle = applyGeminiEnrichmentToBundle(
            effectiveRows,
            files,
            agentResponse,
            body.entity_name_hint
          );
          sendJson(res, 200, {
            ...agentResponse,
            bundle,
          });
          return true;
        }

        sendJson(res, 200, agentResponse);
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Managed Agent audit failed.';
        sendJson(res, 500, { error: message });
        return true;
      }
    }

    // 6. GET / POST /api/drive/folder
    if (pathname === '/api/drive/folder' && (method === 'GET' || method === 'POST')) {
      try {
        const body = method === 'POST' ? await readJsonBody(req) : {};
        const urlOrId = (
          parsedUrl.searchParams.get('url') ??
          parsedUrl.searchParams.get('folderUrl') ??
          parsedUrl.searchParams.get('id') ??
          (typeof body.url === 'string' ? body.url : '') ??
          (typeof body.folderUrl === 'string' ? body.folderUrl : '')
        ).trim();

        if (!urlOrId) {
          sendJson(res, 400, { error: 'Missing `url` parameter for Google Drive folder/sheet.' });
          return true;
        }

        const accessToken = extractAccessToken(req, parsedUrl, body);
        const listing = await listDriveFolder(urlOrId, accessToken);
        sendJson(res, 200, listing);
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to list Google Drive folder.';
        sendJson(res, 400, { error: message });
        return true;
      }
    }

    // 7. POST / GET /api/drive/fetch
    if (
      (pathname === '/api/drive/fetch' || pathname === '/api/drive/fetch-file') &&
      (method === 'POST' || method === 'GET')
    ) {
      try {
        const body = method === 'POST' ? await readJsonBody(req) : {};
        const explicitFileId = (
          (typeof body.fileId === 'string' ? body.fileId : '') ||
          parsedUrl.searchParams.get('fileId') ||
          ''
        ).trim();
        const fileIdOrUrl = (
          explicitFileId ||
          (typeof body.url === 'string' ? body.url : '') ||
          (typeof body.id === 'string' ? body.id : '') ||
          parsedUrl.searchParams.get('url') ||
          parsedUrl.searchParams.get('id') ||
          ''
        ).trim();

        if (!fileIdOrUrl) {
          sendJson(res, 400, { error: 'Missing `fileId` or `url` to fetch from Google Drive.' });
          return true;
        }

        const accessToken = extractAccessToken(req, parsedUrl, body);

        // If a folder URL was sent directly to /api/drive/fetch without an explicit fileId,
        // list the folder and download up to 10 files automatically.
        if (!explicitFileId && /\/folders\/([a-zA-Z0-9_-]{10,})/i.test(fileIdOrUrl)) {
          const listing = await listDriveFolder(fileIdOrUrl, accessToken);
          const fetchedFiles: RawIngestFile[] = [];
          for (const entry of listing.files.slice(0, 10)) {
            try {
              const rf = await fetchDriveFileContent(
                entry.downloadUrl || entry.id,
                entry.mimeType,
                accessToken,
                entry.name
              );
              fetchedFiles.push(rf);
            } catch {
              // Skip unreadable individual file inside folder
            }
          }
          sendJson(res, 200, {
            folder: listing,
            files: fetchedFiles,
            file: fetchedFiles[0],
          });
          return true;
        }

        const mimeType =
          typeof body.mimeType === 'string'
            ? body.mimeType
            : (parsedUrl.searchParams.get('mimeType') ?? undefined);
        const fileName =
          typeof body.fileName === 'string'
            ? body.fileName
            : typeof body.name === 'string'
              ? body.name
              : (parsedUrl.searchParams.get('fileName') ?? undefined);

        const rawFile = await fetchDriveFileContent(fileIdOrUrl, mimeType, accessToken, fileName);

        sendJson(res, 200, {
          ...rawFile,
          file: rawFile,
          files: [rawFile],
        });
        return true;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to fetch file from Google Drive.';
        sendJson(res, 400, { error: message });
        return true;
      }
    }

    sendJson(res, 404, { error: `Unknown API endpoint: ${pathname}` });
    return true;
  };
}

export function createAskHttpServer(options?: ApiHandlerOptions): http.Server {
  const handleApi = createApiHandler(options);

  const server = http.createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const parsedUrl = new URL(req.url ?? '/', 'http://localhost');
    const pathname = parsedUrl.pathname;

    if (method === 'OPTIONS') {
      res.writeHead(204, buildCorsHeaders(req));
      res.end();
      return;
    }

    const handledByApi = await handleApi(req, res);
    if (handledByApi) {
      return;
    }

    // Serve capture deliverables from `capture/` if requested
    if (
      pathname.startsWith('/capture/') &&
      fs.existsSync(CAPTURE_DIR) &&
      (method === 'GET' || method === 'HEAD')
    ) {
      const relCapture = pathname.replace(/^\/capture\/+/, '');
      const candidateCapture = path.resolve(CAPTURE_DIR, relCapture);
      if (
        candidateCapture.startsWith(CAPTURE_DIR + path.sep) &&
        fs.existsSync(candidateCapture) &&
        fs.statSync(candidateCapture).isFile()
      ) {
        const ext = path.extname(candidateCapture).toLowerCase();
        const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        if (method === 'HEAD') {
          res.end();
        } else {
          fs.createReadStream(candidateCapture).pipe(res);
        }
        return;
      }
    }

    // Serve static files from `dist/` if built
    if (fs.existsSync(DIST_DIR) && (method === 'GET' || method === 'HEAD')) {
      const relPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const candidatePath = path.resolve(DIST_DIR, relPath);

      if (candidatePath === DIST_DIR || candidatePath.startsWith(DIST_DIR + path.sep)) {
        const targetFile =
          fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()
            ? candidatePath
            : path.join(DIST_DIR, 'index.html');

        if (fs.existsSync(targetFile)) {
          const ext = path.extname(targetFile).toLowerCase();
          const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
          res.writeHead(200, { 'Content-Type': contentType });
          if (method === 'HEAD') {
            res.end();
          } else {
            fs.createReadStream(targetFile).pipe(res);
          }
          return;
        }
      }
    }

    // Fallback to root `index.html` if `dist/` has not been built yet
    const rootIndexHtml = path.join(APP_ROOT, 'index.html');
    if (
      (pathname === '/' || pathname === '/index.html') &&
      fs.existsSync(rootIndexHtml) &&
      (method === 'GET' || method === 'HEAD')
    ) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (method === 'HEAD') {
        res.end();
      } else {
        fs.createReadStream(rootIndexHtml).pipe(res);
      }
      return;
    }

    sendJson(res, 404, { error: `Not found: ${pathname}` });
  });
  server.requestTimeout = 0;
  server.timeout = 0;
  return server;
}

// Start server when run directly via `tsx server/index.ts`
const invokedScript = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedScript === __filename) {
  const config = loadServerConfig();
  const server = createAskHttpServer({ config });
  server.listen(config.port, config.host, () => {
    console.log(
      `[AskServer] Listening on http://${config.host}:${config.port} (model=${config.modelName}, key=${config.hasApiKey ? 'configured' : 'offline-fallback'})`
    );
  });
}
