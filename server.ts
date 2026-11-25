/**
 * AI Studio Full-Stack Root Entrypoint (`server.ts`)
 *
 * Boots an HTTP server that:
 * 1. Parses `--port <N>` / `--port=<N>` and `process.env.PORT || 3000`, binding to `'0.0.0.0'`.
 * 2. Serves dynamic SEO `/robots.txt` & `/sitemap.xml` anchored to APP_URL / request host.
 * 3. Routes all `/api/*` requests through `createApiHandler` from `./server/index.js`.
 * 4. Serves Vite middleware (dev) or static `dist/` (production) with per-route SSR SEO meta injection.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildRobotsTxt,
  buildRouteSeoHeadHtml,
  buildSitemapXml,
  matchSeoPage,
} from './src/media/seo-pages.js';
import { loadServerConfig } from './server/config.js';
import { createApiHandler } from './server/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_DIR = path.join(__dirname, 'dist');
const ROOT_INDEX_HTML = path.join(__dirname, 'index.html');

const STATIC_MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
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
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function resolvePublicOrigin(req: http.IncomingMessage): string {
  const configured = (process.env.APP_URL || '').trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // fall through
    }
  }
  const protoHeader = (req.headers['x-forwarded-proto'] as string | undefined)
    ?.split(',')[0]
    ?.trim();
  const hostHeader =
    ((req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0]?.trim() ||
      req.headers.host ||
      'localhost:3000').trim();
  const proto = protoHeader === 'https' || protoHeader === 'http' ? protoHeader : 'http';
  return `${proto}://${hostHeader}`;
}

function injectRouteSeoIntoHtml(
  html: string,
  pathname: string,
  origin: string,
  lang?: string | null
): string {
  const startMarker = '<!--BLUEDROP_SEO_META_START-->';
  const endMarker = '<!--BLUEDROP_SEO_META_END-->';
  let updated = html;

  if (lang === 'ar' || lang === 'ary') {
    updated = updated.replace(/<html\s+lang="[^"]*"/i, '<html lang="ar" dir="rtl"');
  } else if (lang === 'fr') {
    updated = updated.replace(/<html\s+lang="[^"]*"/i, '<html lang="fr" dir="ltr"');
  }

  const startIdx = updated.indexOf(startMarker);
  const endIdx = updated.indexOf(endMarker);
  const seoBlock = buildRouteSeoHeadHtml(pathname, origin, lang);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    return (
      updated.slice(0, startIdx) +
      startMarker +
      '\n' +
      seoBlock +
      '\n    ' +
      updated.slice(endIdx)
    );
  }
  return updated;
}

function resolvePortAndHost(): { port: number; host: string } {
  const args = process.argv.slice(2);
  let cliPort: number | null = null;
  let cliHost: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--port' && args[i + 1]) {
      const parsed = Number.parseInt(args[i + 1]!, 10);
      if (Number.isInteger(parsed) && parsed > 0) {
        cliPort = parsed;
      }
      i++;
    } else if (arg.startsWith('--port=')) {
      const parsed = Number.parseInt(arg.slice('--port='.length), 10);
      if (Number.isInteger(parsed) && parsed > 0) {
        cliPort = parsed;
      }
    } else if (arg === '--host' && args[i + 1]) {
      cliHost = args[i + 1]!.trim();
      i++;
    } else if (arg.startsWith('--host=')) {
      cliHost = arg.slice('--host='.length).trim();
    }
  }

  const envPort = Number.parseInt(process.env.PORT || '3000', 10);
  const port = cliPort ?? (Number.isInteger(envPort) && envPort > 0 ? envPort : 3000);
  const host = cliHost || process.env.HOST?.trim() || '0.0.0.0';

  return { port, host };
}

async function startFullStackServer(): Promise<void> {
  const config = loadServerConfig();
  const { port, host } = resolvePortAndHost();
  const handleApi = createApiHandler({ config });

  const useStaticDist =
    process.env.NODE_ENV === 'production' && fs.existsSync(path.join(DIST_DIR, 'index.html'));

  let viteServer: import('vite').ViteDevServer | null = null;

  if (!useStaticDist) {
    const { createServer: createViteServer } = await import('vite');
    viteServer = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const handled = await handleApi(req, res);
      if (handled) {
        return;
      }

      const method = req.method ?? 'GET';
      const parsedUrl = new URL(req.url ?? '/', 'http://localhost');
      const pathname = parsedUrl.pathname;
      const langParam = parsedUrl.searchParams.get('lang');
      const origin = resolvePublicOrigin(req);

      // Dynamic SEO crawler endpoints: /robots.txt and /sitemap.xml
      if (pathname === '/robots.txt' && (method === 'GET' || method === 'HEAD')) {
        const body = buildRobotsTxt(origin);
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
        });
        res.end(method === 'HEAD' ? undefined : body);
        return;
      }

      if (pathname === '/sitemap.xml' && (method === 'GET' || method === 'HEAD')) {
        const body = buildSitemapXml(origin);
        res.writeHead(200, {
          'Content-Type': 'application/xml; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
        });
        res.end(method === 'HEAD' ? undefined : body);
        return;
      }

      const isAssetRequest =
        /\.[a-z0-9]{2,12}$/i.test(pathname) && pathname !== '/index.html';
      const isHtmlRoute =
        (method === 'GET' || method === 'HEAD') &&
        !isAssetRequest &&
        !pathname.startsWith('/@') &&
        !pathname.startsWith('/src/') &&
        !pathname.startsWith('/node_modules/');

      if (viteServer) {
        if (isHtmlRoute && (req.headers.accept?.includes('text/html') ?? true)) {
          const matched = matchSeoPage(pathname);
          if (matched && fs.existsSync(ROOT_INDEX_HTML)) {
            const rawHtml = fs.readFileSync(ROOT_INDEX_HTML, 'utf8');
            const transformed = await viteServer.transformIndexHtml(req.url ?? '/', rawHtml);
            const finalHtml = injectRouteSeoIntoHtml(transformed, pathname, origin, langParam);
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'X-Robots-Tag': 'index, follow',
            });
            res.end(method === 'HEAD' ? undefined : finalHtml);
            return;
          }
        }
        viteServer.middlewares(req, res);
        return;
      }

      // Production static serving from `dist/`
      const relPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const candidatePath = path.resolve(DIST_DIR, relPath);

      if (candidatePath === DIST_DIR || candidatePath.startsWith(DIST_DIR + path.sep)) {
        const targetFile =
          fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()
            ? candidatePath
            : path.join(DIST_DIR, 'index.html');

        if (fs.existsSync(targetFile)) {
          const ext = path.extname(targetFile).toLowerCase();
          if (ext === '.html' || isHtmlRoute) {
            const rawHtml = fs.readFileSync(path.join(DIST_DIR, 'index.html'), 'utf8');
            const finalHtml = injectRouteSeoIntoHtml(rawHtml, pathname, origin, langParam);
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'X-Robots-Tag': 'index, follow',
            });
            res.end(method === 'HEAD' ? undefined : finalHtml);
            return;
          }

          const contentType = STATIC_MIME_TYPES[ext] ?? 'application/octet-stream';
          res.writeHead(200, { 'Content-Type': contentType });
          if (method === 'HEAD') {
            res.end();
          } else {
            fs.createReadStream(targetFile).pipe(res);
          }
          return;
        }
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: message }));
    }
  });

  server.listen(port, host, () => {
    console.log(
      `[BLUEDROP] Full-stack server listening on http://${host}:${port} (model=${config.modelName}, key=${config.hasApiKey ? 'configured' : 'offline-fallback'})`
    );
  });
}

void startFullStackServer();
