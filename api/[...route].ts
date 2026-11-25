import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadServerConfig } from '../server/config.js';
import { createApiHandler } from '../server/index.js';
import { buildRobotsTxt, buildSitemapXml } from '../src/media/seo-pages.js';

const config = loadServerConfig();
const handleApi = createApiHandler({ config });

function resolveVercelOrigin(req: IncomingMessage): string {
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
      process.env.VERCEL_URL ||
      'localhost:3000').trim();
  const proto = protoHeader === 'http' || protoHeader === 'https' ? protoHeader : 'https';
  return hostHeader.startsWith('http') ? hostHeader : `${proto}://${hostHeader}`;
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const rawUrl = req.url ?? '/';
  const parsed = new URL(rawUrl, 'http://localhost');
  let pathname = parsed.pathname;
  if (!pathname.startsWith('/api/')) {
    pathname = `/api${pathname.startsWith('/') ? '' : '/'}${pathname}`;
    req.url = `${pathname}${parsed.search}`;
  }

  if (pathname === '/api/seo-robots') {
    const body = buildRobotsTxt(resolveVercelOrigin(req));
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return;
  }

  if (pathname === '/api/seo-sitemap') {
    const body = buildSitemapXml(resolveVercelOrigin(req));
    res.writeHead(200, {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return;
  }

  const handled = await handleApi(req, res);
  if (!handled && !res.headersSent) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'API route not found.' }));
  }
}
