/**
 * Server-Side Media Search, Inspection, Transcript Extraction & FFmpeg Transcoding (`server/media.ts`)
 *
 * Uses zero-key open web protocols (YouTube oEmbed / ytInitialPlayerResponse / timedtext,
 * Piped API, Cobalt API, iTunes Search API, OpenGraph) and local `/usr/bin/ffmpeg`
 * to convert videos, audio, and images into any requested format.
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  FormatOption,
  MediaInspectResult,
  MediaKind,
  MediaPlatform,
  MediaSearchItem,
  TargetFormatId,
} from '../contracts/index.js';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://api.piped.private.coffee',
  'https://pipedapi.tokhmi.xyz',
];

const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://yt.artemislena.eu',
  'https://invidious.nerdvpn.de',
];

const MAX_REMOTE_MEDIA_BYTES = 140 * 1024 * 1024; // 140 MB safety cap

export function isSafeExternalHttpUrl(raw: string): URL | null {
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      host.endsWith('.local') ||
      host.endsWith('.internal')
    ) {
      return null;
    }
    // Block private IPv4 ranges
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
      const parts = host.split('.').map((p) => Number.parseInt(p, 10));
      if (
        parts[0] === 10 ||
        parts[0] === 127 ||
        parts[0] === 0 ||
        (parts[0] === 169 && parts[1] === 254) ||
        (parts[0] === 172 && (parts[1] ?? 0) >= 16 && (parts[1] ?? 0) <= 31) ||
        (parts[0] === 192 && parts[1] === 168)
      ) {
        return null;
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

export function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

function parseDurationLabelToSec(label: string): number {
  const parts = label
    .trim()
    .split(':')
    .map((n) => Number.parseInt(n, 10))
    .filter((n) => Number.isFinite(n));
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  if (parts.length === 1) return parts[0]!;
  return 0;
}

function parseIso8601DurationSec(iso: string): number {
  const m = iso.trim().match(/^P(?:\d+D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
  if (!m) return 0;
  const h = Number.parseInt(m[1] ?? '0', 10) || 0;
  const min = Number.parseInt(m[2] ?? '0', 10) || 0;
  const s = Number.parseInt(m[3] ?? '0', 10) || 0;
  return h * 3600 + min * 60 + s;
}

export function detectPlatform(urlStr: string): MediaPlatform {
  const lower = urlStr.toLowerCase();
  if (lower.includes('youtube.com') || lower.includes('youtu.be')) return 'youtube';
  if (lower.includes('tiktok.com')) return 'tiktok';
  if (lower.includes('instagram.com')) return 'instagram';
  if (lower.includes('facebook.com') || lower.includes('fb.watch')) return 'facebook';
  if (lower.includes('twitter.com') || lower.includes('x.com')) return 'x';
  if (lower.includes('soundcloud.com')) return 'soundcloud';
  if (lower.includes('audius.co')) return 'audius';
  if (lower.includes('bandcamp.com')) return 'bandcamp';
  if (lower.includes('spotify.com')) return 'spotify';
  if (lower.includes('archive.org')) return 'archive';
  if (lower.includes('streamable.com')) return 'streamable';
  if (lower.includes('vimeo.com')) return 'vimeo';
  if (lower.includes('dailymotion.com') || lower.includes('dai.ly')) return 'dailymotion';
  if (lower.includes('reddit.com') || lower.includes('v.redd.it')) return 'reddit';
  if (lower.includes('apple.com') || lower.includes('mzstatic.com')) return 'itunes';
  return 'direct';
}

export function extractYouTubeVideoId(urlStr: string): string | null {
  try {
    const u = new URL(urlStr);
    const host = u.hostname.toLowerCase();
    if (host.includes('youtu.be')) {
      const seg = u.pathname.replace(/^\/+/, '').split('/')[0];
      return seg && /^[a-zA-Z0-9_-]{11}$/.test(seg) ? seg : null;
    }
    if (host.includes('youtube.com')) {
      const v = u.searchParams.get('v');
      if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;
      const parts = u.pathname.split('/').filter(Boolean);
      if (
        (parts[0] === 'shorts' || parts[0] === 'embed' || parts[0] === 'live') &&
        parts[1] &&
        /^[a-zA-Z0-9_-]{11}$/.test(parts[1])
      ) {
        return parts[1];
      }
    }
  } catch {
    // Ignore invalid URL
  }
  return null;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 5500
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        ...(init.headers ?? {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

interface ItunesResult {
  trackId?: number;
  trackName?: string;
  artistName?: string;
  artworkUrl100?: string;
  trackTimeMillis?: number;
  previewUrl?: string;
  trackViewUrl?: string;
  primaryGenreName?: string;
}

async function searchItunes(
  query: string,
  limit = 8,
  mediaType: 'music' | 'musicVideo' = 'music'
): Promise<MediaSearchItem[]> {
  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=${mediaType}&limit=${limit}`;
    const resp = await fetchWithTimeout(url, {}, 4500);
    if (!resp.ok) return [];
    const data = (await resp.json()) as { results?: ItunesResult[] };
    const rows = Array.isArray(data.results) ? data.results : [];
    return rows
      .filter((r) => Boolean(r.trackName))
      .map((r, idx) => {
        const durationSec = Math.round((r.trackTimeMillis ?? 30000) / 1000);
        const thumb = (r.artworkUrl100 ?? '').replace('100x100bb', '600x600bb');
        const kind: MediaKind = mediaType === 'musicVideo' ? 'video' : 'audio';
        return {
          id: `itunes-${mediaType}-${r.trackId ?? idx}`,
          title: r.trackName ?? 'Untitled Track',
          creator: r.artistName ?? 'Unknown Artist',
          platform: 'itunes',
          kind,
          durationSec,
          durationLabel: formatDuration(durationSec),
          thumbnailUrl: thumb,
          sourceUrl: r.previewUrl || r.trackViewUrl || '',
          previewStreamUrl: r.previewUrl,
          genreOrTag: r.primaryGenreName ?? (kind === 'video' ? 'Music Video' : 'Music'),
        };
      });
  } catch {
    return [];
  }
}

interface PipedSearchItem {
  url?: string;
  title?: string;
  uploaderName?: string;
  thumbnail?: string;
  duration?: number;
  views?: number;
  type?: string;
}

async function searchPiped(query: string): Promise<MediaSearchItem[]> {
  for (const base of PIPED_INSTANCES) {
    try {
      const resp = await fetchWithTimeout(
        `${base}/search?q=${encodeURIComponent(query)}&filter=all`,
        {},
        3200
      );
      if (!resp.ok) continue;
      const json = (await resp.json()) as { items?: PipedSearchItem[] };
      const items = Array.isArray(json.items) ? json.items : [];
      const mapped = items
        .filter((it) => it.url && it.title && (it.type === 'stream' || it.url.includes('/watch?v=')))
        .slice(0, 10)
        .map((it) => {
          const watchPath = it.url!.startsWith('http')
            ? it.url!
            : `https://www.youtube.com${it.url!}`;
          const vidId = extractYouTubeVideoId(watchPath) ?? crypto.randomUUID().slice(0, 11);
          const durationSec = Math.max(0, Number(it.duration ?? 0));
          return {
            id: `yt-${vidId}`,
            title: it.title!,
            creator: it.uploaderName || 'YouTube Creator',
            platform: 'youtube' as const,
            kind: 'video' as const,
            durationSec,
            durationLabel: durationSec > 0 ? formatDuration(durationSec) : 'LIVE',
            thumbnailUrl: it.thumbnail || `https://i.ytimg.com/vi/${vidId}/hqdefault.jpg`,
            sourceUrl: `https://www.youtube.com/watch?v=${vidId}`,
            viewsLabel:
              typeof it.views === 'number' && it.views > 0
                ? `${Intl.NumberFormat('en', { notation: 'compact' }).format(it.views)} views`
                : undefined,
          };
        });
      if (mapped.length > 0) {
        return mapped;
      }
    } catch {
      // Try next Piped instance
    }
  }
  return [];
}

async function searchYouTubeHtml(query: string): Promise<MediaSearchItem[]> {
  try {
    const resp = await fetchWithTimeout(
      `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
      {
        headers: {
          'Accept-Language': 'en-US,en;q=0.9',
        },
      },
      4500
    );
    if (!resp.ok) return [];
    const html = await resp.text();
    const marker = 'var ytInitialData = ';
    const startIdx = html.indexOf(marker);
    if (startIdx < 0) return [];
    const jsonStart = startIdx + marker.length;
    const endIdx = html.indexOf(';</script>', jsonStart);
    if (endIdx < 0) return [];

    const parsed = JSON.parse(html.slice(jsonStart, endIdx)) as Record<string, unknown>;
    const results: MediaSearchItem[] = [];

    const walk = (node: unknown): void => {
      if (results.length >= 10 || !node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      const obj = node as Record<string, unknown>;
      const vr = obj.videoRenderer as Record<string, unknown> | undefined;
      if (vr && typeof vr.videoId === 'string') {
        const vidId = vr.videoId;
        const titleRuns = ((vr.title as Record<string, unknown>)?.runs ?? []) as Array<{
          text?: string;
        }>;
        const ownerRuns = ((vr.ownerText as Record<string, unknown>)?.runs ?? []) as Array<{
          text?: string;
        }>;
        const title = titleRuns.map((r) => r.text ?? '').join('').trim();
        const creator = ownerRuns.map((r) => r.text ?? '').join('').trim() || 'YouTube';
        const lengthText =
          ((vr.lengthText as Record<string, unknown>)?.simpleText as string | undefined) ?? '0:00';
        const viewText =
          ((vr.shortViewCountText as Record<string, unknown>)?.simpleText as string | undefined) ??
          undefined;
        const durationSec = parseDurationLabelToSec(lengthText);
        if (title) {
          results.push({
            id: `yt-${vidId}`,
            title,
            creator,
            platform: 'youtube',
            kind: 'video',
            durationSec,
            durationLabel: durationSec > 0 ? formatDuration(durationSec) : lengthText,
            thumbnailUrl: `https://i.ytimg.com/vi/${vidId}/hqdefault.jpg`,
            sourceUrl: `https://www.youtube.com/watch?v=${vidId}`,
            viewsLabel: viewText,
          });
        }
        return;
      }
      for (const val of Object.values(obj)) {
        walk(val);
      }
    };

    walk(parsed);
    return results;
  } catch {
    return [];
  }
}

async function searchDeezer(query: string, limit = 8): Promise<MediaSearchItem[]> {
  try {
    const url = `https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=${limit}`;
    const resp = await fetchWithTimeout(url, {}, 4000);
    if (!resp.ok) return [];
    const json = (await resp.json()) as {
      data?: Array<{
        id?: number;
        title?: string;
        duration?: number;
        preview?: string;
        link?: string;
        rank?: number;
        artist?: { name?: string };
        album?: { title?: string; cover_xl?: string; cover_big?: string; cover_medium?: string };
      }>;
    };
    const rows = Array.isArray(json.data) ? json.data : [];
    return rows
      .filter((r) => Boolean(r.id && r.title))
      .map((r) => {
        const durationSec = Math.max(0, Number(r.duration ?? 30));
        const thumb = r.album?.cover_xl || r.album?.cover_big || r.album?.cover_medium || '';
        return {
          id: `deezer-${r.id}`,
          title: r.title!,
          creator: r.artist?.name || 'Artist',
          platform: 'audius' as const,
          kind: 'audio' as const,
          durationSec,
          durationLabel: durationSec > 0 ? formatDuration(durationSec) : 'AUDIO',
          thumbnailUrl: thumb,
          sourceUrl: r.preview || r.link || '',
          previewStreamUrl: r.preview,
          genreOrTag: r.album?.title || 'Deezer Music',
        };
      });
  } catch {
    return [];
  }
}

interface AudiusTrack {
  id?: string;
  title?: string;
  duration?: number;
  genre?: string;
  permalink?: string;
  play_count?: number;
  user?: { name?: string; handle?: string };
  artwork?: { '480x480'?: string; '150x150'?: string; '1000x1000'?: string };
}

async function searchAudius(query: string, limit = 6): Promise<MediaSearchItem[]> {
  try {
    const url = `https://api.audius.co/v1/tracks/search?query=${encodeURIComponent(query)}&app_name=BLUEDROP&limit=${limit}`;
    const resp = await fetchWithTimeout(url, {}, 4200);
    if (!resp.ok) return [];
    const json = (await resp.json()) as { data?: AudiusTrack[] };
    const rows = Array.isArray(json.data) ? json.data : [];
    return rows
      .filter((t) => Boolean(t.id && t.title))
      .map((t) => {
        const durationSec = Math.max(0, Number(t.duration ?? 0));
        const streamUrl = `https://api.audius.co/v1/tracks/${encodeURIComponent(t.id!)}/stream?app_name=BLUEDROP`;
        const perm = t.permalink
          ? `https://audius.co${t.permalink.startsWith('/') ? '' : '/'}${t.permalink}`
          : streamUrl;
        const thumb =
          t.artwork?.['480x480'] || t.artwork?.['1000x1000'] || t.artwork?.['150x150'] || '';
        return {
          id: `audius-${t.id}`,
          title: t.title!,
          creator: t.user?.name || t.user?.handle || 'Audius Artist',
          platform: 'audius' as const,
          kind: 'audio' as const,
          durationSec,
          durationLabel: durationSec > 0 ? formatDuration(durationSec) : 'FULL TRACK',
          thumbnailUrl: thumb,
          sourceUrl: perm,
          previewStreamUrl: streamUrl,
          viewsLabel:
            typeof t.play_count === 'number' && t.play_count > 0
              ? `${Intl.NumberFormat('en', { notation: 'compact' }).format(t.play_count)} plays`
              : undefined,
          genreOrTag: t.genre || 'Full Stream',
        };
      });
  } catch {
    return [];
  }
}

interface InvidiousSearchRow {
  type?: string;
  videoId?: string;
  title?: string;
  author?: string;
  lengthSeconds?: number;
  viewCount?: number;
  videoThumbnails?: Array<{ url?: string; quality?: string }>;
}

async function searchInvidious(query: string): Promise<MediaSearchItem[]> {
  for (const base of INVIDIOUS_INSTANCES) {
    try {
      const resp = await fetchWithTimeout(
        `${base}/api/v1/search?q=${encodeURIComponent(query)}&type=video`,
        {},
        3500
      );
      if (!resp.ok) continue;
      const rows = (await resp.json()) as InvidiousSearchRow[];
      if (!Array.isArray(rows)) continue;
      const mapped = rows
        .filter((r) => Boolean(r.videoId && r.title))
        .slice(0, 8)
        .map((r) => {
          const vidId = r.videoId!;
          const durationSec = Math.max(0, Number(r.lengthSeconds ?? 0));
          const thumb =
            r.videoThumbnails?.find((t) => t.quality === 'high')?.url ||
            r.videoThumbnails?.[0]?.url ||
            `https://i.ytimg.com/vi/${vidId}/hqdefault.jpg`;
          return {
            id: `yt-${vidId}`,
            title: r.title!,
            creator: r.author || 'YouTube Creator',
            platform: 'youtube' as const,
            kind: 'video' as const,
            durationSec,
            durationLabel: durationSec > 0 ? formatDuration(durationSec) : 'VIDEO',
            thumbnailUrl: thumb.startsWith('http') ? thumb : `${base}${thumb}`,
            sourceUrl: `https://www.youtube.com/watch?v=${vidId}`,
            viewsLabel:
              typeof r.viewCount === 'number' && r.viewCount > 0
                ? `${Intl.NumberFormat('en', { notation: 'compact' }).format(r.viewCount)} views`
                : undefined,
          };
        });
      if (mapped.length > 0) return mapped;
    } catch {
      // try next Invidious host
    }
  }
  return [];
}

async function searchArchiveOrg(
  query: string,
  filter: 'all' | 'music' | 'video'
): Promise<MediaSearchItem[]> {
  try {
    const mediaFilter =
      filter === 'music' ? 'mediatype:audio' : filter === 'video' ? 'mediatype:movies' : '(mediatype:movies OR mediatype:audio)';
    const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(`${query} AND ${mediaFilter}`)}&fl[]=identifier,title,creator,mediatype,downloads&rows=4&output=json`;
    const resp = await fetchWithTimeout(url, {}, 3800);
    if (!resp.ok) return [];
    const json = (await resp.json()) as {
      response?: {
        docs?: Array<{
          identifier?: string;
          title?: string;
          creator?: string | string[];
          mediatype?: string;
          downloads?: number;
        }>;
      };
    };
    const docs = json.response?.docs ?? [];
    return docs
      .filter((d) => Boolean(d.identifier && d.title))
      .map((d) => {
        const id = d.identifier!;
        const kind: MediaKind = d.mediatype === 'audio' ? 'audio' : 'video';
        const creator = Array.isArray(d.creator) ? d.creator[0] : d.creator;
        return {
          id: `archive-${id}`,
          title: d.title!,
          creator: creator || 'Internet Archive',
          platform: 'archive' as const,
          kind,
          durationSec: 0,
          durationLabel: 'ARCHIVE',
          thumbnailUrl: `https://archive.org/services/img/${encodeURIComponent(id)}`,
          sourceUrl: `https://archive.org/details/${encodeURIComponent(id)}`,
          viewsLabel:
            typeof d.downloads === 'number' && d.downloads > 0
              ? `${Intl.NumberFormat('en', { notation: 'compact' }).format(d.downloads)} dl`
              : undefined,
          genreOrTag: kind === 'audio' ? 'Open Archive Audio' : 'Open Archive Video',
        };
      });
  } catch {
    return [];
  }
}

export async function searchMedia(
  query: string,
  filter: 'all' | 'music' | 'video' = 'all'
): Promise<{ items: MediaSearchItem[]; sourcesUsed: string[] }> {
  const trimmed = query.trim();
  if (!trimmed) {
    return { items: [], sourcesUsed: [] };
  }

  const sourcesUsed: string[] = [];
  const tasks: Array<Promise<MediaSearchItem[]>> = [];

  if (filter === 'all' || filter === 'music') {
    tasks.push(
      searchAudius(trimmed, filter === 'music' ? 8 : 5).then((res) => {
        if (res.length > 0) sourcesUsed.push('audius');
        return res;
      })
    );
    tasks.push(
      searchDeezer(trimmed, filter === 'music' ? 8 : 4).then((res) => {
        if (res.length > 0) sourcesUsed.push('deezer');
        return res;
      })
    );
    tasks.push(
      searchItunes(trimmed, filter === 'music' ? 8 : 4, 'music').then((res) => {
        if (res.length > 0) sourcesUsed.push('itunes');
        return res;
      })
    );
  }

  if (filter === 'all' || filter === 'video') {
    tasks.push(
      searchItunes(trimmed, filter === 'video' ? 4 : 3, 'musicVideo').then((res) => {
        if (res.length > 0) sourcesUsed.push('itunes-video');
        return res;
      })
    );
    tasks.push(
      (async () => {
        const inv = await searchInvidious(trimmed);
        if (inv.length > 0) {
          sourcesUsed.push('invidious');
          return inv;
        }
        const piped = await searchPiped(trimmed);
        if (piped.length > 0) {
          sourcesUsed.push('piped');
          return piped;
        }
        const ytHtml = await searchYouTubeHtml(trimmed);
        if (ytHtml.length > 0) sourcesUsed.push('youtube');
        return ytHtml;
      })()
    );
  }

  tasks.push(
    searchArchiveOrg(trimmed, filter).then((res) => {
      if (res.length > 0) sourcesUsed.push('archive.org');
      return res;
    })
  );

  const settled = await Promise.all(tasks);
  const combined: MediaSearchItem[] = [];
  const seen = new Set<string>();

  // Interleave sources evenly and cap to 16 cards (4x4 desktop, 2x8 tablet -> zero orphan trailing cards)
  const maxLen = Math.max(...settled.map((list) => list.length), 0);
  for (let i = 0; i < maxLen && combined.length < 16; i++) {
    for (const list of settled) {
      if (combined.length >= 16) break;
      const item = list[i];
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      combined.push(item);
    }
  }

  return { items: combined, sourcesUsed };
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

async function fetchTimedTextTranscript(
  captionBaseUrl: string
): Promise<Array<{ startSec: number; text: string }>> {
  try {
    const safeUrl = isSafeExternalHttpUrl(captionBaseUrl);
    if (!safeUrl) return [];
    const resp = await fetchWithTimeout(safeUrl.toString(), {}, 4500);
    if (!resp.ok) return [];
    const xml = await resp.text();
    const segments: Array<{ startSec: number; text: string }> = [];
    const regex = /<text\s+start="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(xml)) !== null) {
      const startSec = Number.parseFloat(match[1] ?? '0');
      const rawText = decodeHtmlEntities((match[2] ?? '').replace(/<[^>]+>/g, ' ').trim());
      if (rawText) {
        segments.push({ startSec, text: rawText });
      }
      if (segments.length >= 200) break;
    }
    return segments;
  } catch {
    return [];
  }
}

async function resolveCobaltDirectStream(
  targetUrl: string,
  audioOnly = false
): Promise<{ url?: string; note?: string }> {
  const cobaltEndpoints = [
    process.env.COBALT_API_URL?.trim(),
  ].filter((v): v is string => Boolean(v));

  for (const endpoint of cobaltEndpoints) {
    try {
      const resp = await fetchWithTimeout(
        endpoint,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            url: targetUrl,
            downloadMode: audioOnly ? 'audio' : 'auto',
            videoQuality: '1080',
            audioFormat: 'mp3',
          }),
        },
        4000
      );
      if (!resp.ok) continue;
      const data = (await resp.json()) as {
        status?: string;
        url?: string;
        picker?: Array<{ url?: string }>;
      };
      const picked = data.url || data.picker?.[0]?.url;
      if (picked && isSafeExternalHttpUrl(picked)) {
        return { url: picked, note: 'Cobalt stream resolved' };
      }
    } catch {
      // Cobalt instance unreachable or requires auth
    }
  }
  return {};
}

async function resolveYouTubeInvidious(videoId: string): Promise<{
  title?: string;
  creator?: string;
  durationSec?: number;
  directVideoUrl?: string;
  directAudioUrl?: string;
}> {
  for (const base of INVIDIOUS_INSTANCES) {
    try {
      const resp = await fetchWithTimeout(`${base}/api/v1/videos/${videoId}`, {}, 3800);
      if (!resp.ok) continue;
      const json = (await resp.json()) as {
        title?: string;
        author?: string;
        lengthSeconds?: number;
        formatStreams?: Array<{ url?: string; qualityLabel?: string }>;
        adaptiveFormats?: Array<{ url?: string; type?: string; bitrate?: string }>;
      };
      const vid = json.formatStreams?.find((f) => f.url && isSafeExternalHttpUrl(f.url))?.url;
      const aud = (json.adaptiveFormats ?? [])
        .filter((f) => f.type?.startsWith('audio/') && f.url && isSafeExternalHttpUrl(f.url))
        .sort((a, b) => Number(b.bitrate ?? 0) - Number(a.bitrate ?? 0))[0]?.url;
      if (vid || aud || json.title) {
        return {
          title: json.title,
          creator: json.author,
          durationSec: json.lengthSeconds,
          directVideoUrl: vid,
          directAudioUrl: aud,
        };
      }
    } catch {
      // next Invidious node
    }
  }
  return {};
}

async function resolveYouTubeInnerTube(videoId: string): Promise<{
  directVideoUrl?: string;
  directAudioUrl?: string;
  title?: string;
  creator?: string;
  durationSec?: number;
}> {
  const clients = [
    {
      clientName: 'ANDROID_VR',
      clientVersion: '1.60.19',
      androidSdkVersion: 32,
      userAgent: 'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    },
    {
      clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
      clientVersion: '2.0',
      userAgent: USER_AGENT,
    },
  ];

  for (const c of clients) {
    try {
      const resp = await fetchWithTimeout(
        'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': c.userAgent,
          },
          body: JSON.stringify({
            videoId,
            context: {
              client: {
                clientName: c.clientName,
                clientVersion: c.clientVersion,
                ...(c.androidSdkVersion ? { androidSdkVersion: c.androidSdkVersion } : {}),
                hl: 'en',
                gl: 'US',
              },
              thirdParty: { embedUrl: 'https://www.youtube.com/' },
            },
          }),
        },
        4200
      );
      if (!resp.ok) continue;
      const data = (await resp.json()) as {
        videoDetails?: { title?: string; author?: string; lengthSeconds?: string };
        streamingData?: {
          formats?: Array<{ url?: string; mimeType?: string }>;
          adaptiveFormats?: Array<{ url?: string; mimeType?: string; bitrate?: number }>;
        };
      };
      const muxed = data.streamingData?.formats?.find((f) => f.url && isSafeExternalHttpUrl(f.url))?.url;
      const audio = (data.streamingData?.adaptiveFormats ?? [])
        .filter((f) => f.mimeType?.startsWith('audio/') && f.url && isSafeExternalHttpUrl(f.url))
        .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0]?.url;
      if (muxed || audio) {
        return {
          title: data.videoDetails?.title,
          creator: data.videoDetails?.author,
          durationSec: Number.parseInt(data.videoDetails?.lengthSeconds ?? '0', 10) || undefined,
          directVideoUrl: muxed,
          directAudioUrl: audio,
        };
      }
    } catch {
      // next InnerTube client
    }
  }
  return {};
}

export function buildDefaultFormatMatrix(params: {
  kind: MediaKind;
  hasTranscript: boolean;
  directVideoUrl?: string;
  directAudioUrl?: string;
  hasThumbnail: boolean;
}): FormatOption[] {
  const { kind, hasTranscript, directVideoUrl, directAudioUrl, hasThumbnail } = params;
  const list: FormatOption[] = [];

  if (kind === 'video') {
    list.push(
      {
        id: 'mp4-4k',
        label: 'MP4 · 4K Ultra HD',
        ext: 'mp4',
        category: 'video',
        quality: '2160p',
        codec: 'H.264 / AAC',
        available: true,
        directUrl: directVideoUrl,
      },
      {
        id: 'mp4-1080',
        label: 'MP4 · Full HD',
        ext: 'mp4',
        category: 'video',
        quality: '1080p',
        codec: 'H.264 / AAC',
        available: true,
        directUrl: directVideoUrl,
      },
      {
        id: 'mp4-720',
        label: 'MP4 · Fast Stream',
        ext: 'mp4',
        category: 'video',
        quality: '720p',
        codec: 'H.264 / AAC',
        available: true,
        directUrl: directVideoUrl,
      },
      {
        id: 'webm',
        label: 'WEBM · VP9 Web',
        ext: 'webm',
        category: 'video',
        quality: '1080p',
        codec: 'VP9 / Opus',
        available: true,
      },
      {
        id: 'mkv',
        label: 'MKV · Matroska',
        ext: 'mkv',
        category: 'video',
        quality: 'Original',
        codec: 'H.264 / AAC',
        available: true,
      },
      {
        id: 'mov',
        label: 'MOV · Pro QuickTime',
        ext: 'mov',
        category: 'video',
        quality: '1080p',
        codec: 'H.264 / PCM',
        available: true,
      },
      {
        id: 'gif',
        label: 'GIF · Loop Clip',
        ext: 'gif',
        category: 'video',
        quality: '480p 15fps',
        codec: 'Palette GIF',
        available: true,
      }
    );
  }

  if (kind === 'video' || kind === 'audio') {
    list.push(
      {
        id: 'mp3-320',
        label: 'MP3 · Studio Master',
        ext: 'mp3',
        category: 'audio',
        quality: '320 kbps',
        codec: 'LAME MP3 + ID3',
        available: true,
        directUrl: directAudioUrl,
      },
      {
        id: 'mp3-192',
        label: 'MP3 · Standard',
        ext: 'mp3',
        category: 'audio',
        quality: '192 kbps',
        codec: 'LAME MP3 + ID3',
        available: true,
      },
      {
        id: 'wav',
        label: 'WAV · Lossless PCM',
        ext: 'wav',
        category: 'audio',
        quality: '1411 kbps',
        codec: 'PCM 16-bit',
        available: true,
      },
      {
        id: 'flac',
        label: 'FLAC · Hi-Res Lossless',
        ext: 'flac',
        category: 'audio',
        quality: '24-bit',
        codec: 'FLAC',
        available: true,
      },
      {
        id: 'aac',
        label: 'AAC · High Efficiency',
        ext: 'aac',
        category: 'audio',
        quality: '256 kbps',
        codec: 'AAC-LC',
        available: true,
      },
      {
        id: 'ogg',
        label: 'OGG · Vorbis',
        ext: 'ogg',
        category: 'audio',
        quality: '256 kbps',
        codec: 'Vorbis',
        available: true,
      },
      {
        id: 'm4a',
        label: 'M4A · Apple Audio',
        ext: 'm4a',
        category: 'audio',
        quality: '256 kbps',
        codec: 'AAC / MP4',
        available: true,
        directUrl: directAudioUrl,
      }
    );
  }

  if (hasThumbnail || kind === 'image') {
    list.push(
      {
        id: 'png',
        label: 'PNG · Cover Art',
        ext: 'png',
        category: 'image',
        quality: 'Cover Art',
        codec: 'PNG-24',
        available: true,
      },
      {
        id: 'jpg',
        label: 'JPG · Cover Art HD',
        ext: 'jpg',
        category: 'image',
        quality: 'Cover Art HD',
        codec: 'JPEG',
        available: true,
      },
      {
        id: 'webp',
        label: 'WEBP · Cover Art Light',
        ext: 'webp',
        category: 'image',
        quality: 'Cover Art',
        codec: 'WebP',
        available: true,
      }
    );
  }

  if (hasTranscript) {
    list.push(
      {
        id: 'srt',
        label: 'SRT · Timecoded Captions',
        ext: 'srt',
        category: 'subtitle',
        quality: 'UTF-8',
        codec: 'SubRip',
        available: true,
      },
      {
        id: 'txt',
        label: 'TXT · Clean Transcript',
        ext: 'txt',
        category: 'subtitle',
        quality: 'UTF-8',
        codec: 'Plain Text',
        available: true,
      }
    );
  }

  return list;
}

export function parseLrcSyncedLines(lrc: string): Array<{ timeSec: number; line: string }> {
  const out: Array<{ timeSec: number; line: string }> = [];
  for (const rawLine of lrc.split(/\r?\n/)) {
    const match = rawLine.match(/^\s*\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\]\s*(.*)$/);
    if (!match) continue;
    const min = Number.parseInt(match[1] ?? '0', 10) || 0;
    const sec = Number.parseInt(match[2] ?? '0', 10) || 0;
    const msStr = (match[3] ?? '0').padEnd(3, '0').slice(0, 3);
    const ms = Number.parseInt(msStr, 10) || 0;
    const line = (match[4] ?? '').trim();
    if (line) {
      out.push({ timeSec: min * 60 + sec + ms / 1000, line });
    }
  }
  return out;
}

export async function fetchLyricsFromLrclib(
  title: string,
  artist?: string
): Promise<{
  lyricsText?: string;
  lyricsSynced?: Array<{ timeSec: number; line: string }>;
  lyricsSource?: string;
}> {
  const cleanTitle = title
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b(?:feat\.?|ft\.?)\s+[^-|/]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleanTitle || cleanTitle.length < 2) return {};

  const queryCandidates: string[] = [];
  const lowerArtist = (artist || '').toLowerCase();
  const artistUseful =
    Boolean(artist?.trim()) &&
    !lowerArtist.includes('creator') &&
    !lowerArtist.includes('youtube') &&
    !cleanTitle.toLowerCase().includes(lowerArtist);

  if (artistUseful && !cleanTitle.includes(' - ')) {
    queryCandidates.push(`${artist!.trim()} ${cleanTitle}`);
  }
  queryCandidates.push(cleanTitle);

  for (const query of queryCandidates) {
    try {
      const resp = await fetchWithTimeout(
        `https://lrclib.net/api/search?q=${encodeURIComponent(query)}`,
        {},
        3800
      );
      if (!resp.ok) continue;
      const rows = (await resp.json()) as Array<{
        trackName?: string;
        artistName?: string;
        plainLyrics?: string;
        syncedLyrics?: string;
      }>;
      if (!Array.isArray(rows) || rows.length === 0) continue;
      const best =
        rows.find((r) => Boolean(r.syncedLyrics)) ?? rows.find((r) => Boolean(r.plainLyrics));
      if (!best) continue;
      const synced = best.syncedLyrics ? parseLrcSyncedLines(best.syncedLyrics) : undefined;
      const plain =
        best.plainLyrics?.trim() ||
        synced?.map((s) => s.line).join('\n') ||
        undefined;
      if (!plain) continue;
      return {
        lyricsText: plain,
        lyricsSynced: synced && synced.length > 0 ? synced : undefined,
        lyricsSource: `LRCLIB (${best.artistName || artist || ''} — ${best.trackName || cleanTitle})`,
      };
    } catch {
      // try next candidate
    }
  }
  return {};
}

async function resolveShortLinkRedirect(urlStr: string): Promise<string> {
  try {
    const u = new URL(urlStr);
    const shortHosts = [
      'vm.tiktok.com',
      'vt.tiktok.com',
      'fb.watch',
      'on.soundcloud.com',
      't.co',
      'bit.ly',
      'tinyurl.com',
      'l.instagram.com',
    ];
    if (!shortHosts.some((h) => u.hostname.toLowerCase().includes(h))) {
      return urlStr;
    }
    const resp = await fetchWithTimeout(urlStr, { method: 'GET', redirect: 'follow' }, 4000);
    if (resp.url && isSafeExternalHttpUrl(resp.url)) {
      return resp.url;
    }
  } catch {
    // keep original url
  }
  return urlStr;
}

export async function inspectMediaUrl(rawUrl: string): Promise<MediaInspectResult> {
  const initialSafe = isSafeExternalHttpUrl(rawUrl);
  if (!initialSafe) {
    throw new Error('Please provide a valid public http:// or https:// media URL.');
  }

  const expandedUrlStr = await resolveShortLinkRedirect(initialSafe.toString());
  const safeUrl = isSafeExternalHttpUrl(expandedUrlStr) ?? initialSafe;
  const urlStr = safeUrl.toString();
  const platform = detectPlatform(urlStr);

  // 1. YouTube Deep Inspection (oEmbed + ytInitialPlayerResponse + timedtext + Piped/Cobalt)
  if (platform === 'youtube') {
    const videoId = extractYouTubeVideoId(urlStr);
    if (!videoId) {
      throw new Error('Could not find a valid 11-character YouTube video ID in that URL.');
    }
    const canonicalWatch = `https://www.youtube.com/watch?v=${videoId}`;

    let title = `YouTube Video (${videoId})`;
    let creator = 'YouTube Creator';
    let durationSec = 0;
    let description = '';
    let keywords: string[] = [];
    let thumbnailUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    let transcriptSegments: Array<{ startSec: number; text: string }> = [];
    let directVideoUrl: string | undefined;
    let directAudioUrl: string | undefined;
    let extractorNote = 'YouTube metadata + timedtext extracted';

    // Parallel fetch: oEmbed + Watch HTML + Invidious + InnerTube + Piped Streams + Cobalt
    const [oembedRes, watchHtmlRes, invidiousRes, innerTubeRes, pipedStreamRes, cobaltVid, cobaltAud] =
      await Promise.all([
        fetchWithTimeout(
          `https://www.youtube.com/oembed?url=${encodeURIComponent(canonicalWatch)}&format=json`,
          {},
          3500
        ).catch(() => null),
        fetchWithTimeout(
          `${canonicalWatch}&hl=en`,
          { headers: { 'Accept-Language': 'en-US,en;q=0.9' } },
          4500
        ).catch(() => null),
        resolveYouTubeInvidious(videoId),
        resolveYouTubeInnerTube(videoId),
        (async () => {
          for (const base of PIPED_INSTANCES) {
            try {
              const r = await fetchWithTimeout(`${base}/streams/${videoId}`, {}, 2800);
              if (r.ok) return (await r.json()) as Record<string, unknown>;
            } catch {
              // next
            }
          }
          return null;
        })(),
        resolveCobaltDirectStream(canonicalWatch, false),
        resolveCobaltDirectStream(canonicalWatch, true),
      ]);

    if (oembedRes?.ok) {
      try {
        const oe = (await oembedRes.json()) as {
          title?: string;
          author_name?: string;
          thumbnail_url?: string;
        };
        if (oe.title) title = oe.title;
        if (oe.author_name) creator = oe.author_name;
        if (oe.thumbnail_url) thumbnailUrl = oe.thumbnail_url;
      } catch {
        // ignore
      }
    }

    if (watchHtmlRes?.ok) {
      try {
        const html = await watchHtmlRes.text();
        // Extract ISO-8601 duration from HTML microdata even if streamingData requires login
        const isoDurMatch =
          html.match(/<meta[^>]+itemprop=["']duration["'][^>]+content=["']([^"']+)["']/i) ??
          html.match(/itemprop=["']duration["'][^>]+content=["'](PT[^"']+)["']/i);
        if (isoDurMatch?.[1]) {
          const parsedIso = parseIso8601DurationSec(isoDurMatch[1]);
          if (parsedIso > 0) durationSec = parsedIso;
        }
        if (!durationSec) {
          const msMatch = html.match(/"approxDurationMs":"(\d+)"/);
          if (msMatch?.[1]) {
            durationSec = Math.round(Number.parseInt(msMatch[1], 10) / 1000);
          }
        }
        if (!durationSec) {
          const lenMatch = html.match(/"lengthSeconds":"(\d+)"/);
          if (lenMatch?.[1]) {
            durationSec = Number.parseInt(lenMatch[1], 10) || 0;
          }
        }

        const marker = 'var ytInitialPlayerResponse = ';
        const idx = html.indexOf(marker);
        if (idx >= 0) {
          const jsonStart = idx + marker.length;
          const endIdx = html.indexOf(';</script>', jsonStart);
          if (endIdx > jsonStart) {
            const playerResp = JSON.parse(html.slice(jsonStart, endIdx)) as {
              videoDetails?: {
                title?: string;
                author?: string;
                lengthSeconds?: string;
                shortDescription?: string;
                keywords?: string[];
              };
              captions?: {
                playerCaptionsTracklistRenderer?: {
                  captionTracks?: Array<{ baseUrl?: string; languageCode?: string }>;
                };
              };
            };
            if (playerResp.videoDetails?.title) title = playerResp.videoDetails.title;
            if (playerResp.videoDetails?.author) creator = playerResp.videoDetails.author;
            if (playerResp.videoDetails?.lengthSeconds) {
              const sec = Number.parseInt(playerResp.videoDetails.lengthSeconds, 10) || 0;
              if (sec > 0) durationSec = sec;
            }
            if (playerResp.videoDetails?.shortDescription) {
              description = playerResp.videoDetails.shortDescription.slice(0, 1200);
            }
            if (Array.isArray(playerResp.videoDetails?.keywords)) {
              keywords = playerResp.videoDetails.keywords.slice(0, 15);
            }
            const tracks =
              playerResp.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
            const isArabicTitle = /[\u0600-\u06FF]/.test(title || '');
            const preferredTrack =
              (isArabicTitle
                ? tracks.find((t) => t.languageCode?.startsWith('ar'))
                : undefined) ??
              tracks.find((t) => !t.languageCode?.includes('.auto')) ??
              tracks[0];
            if (preferredTrack?.baseUrl) {
              transcriptSegments = await fetchTimedTextTranscript(preferredTrack.baseUrl);
            }
          }
        }
      } catch {
        // ignore parse errors
      }
    }

    if (pipedStreamRes) {
      const pDur = Number(pipedStreamRes.duration ?? 0);
      if (!durationSec && pDur > 0) durationSec = pDur;
      if (typeof pipedStreamRes.title === 'string' && pipedStreamRes.title) {
        title = pipedStreamRes.title;
      }
      if (typeof pipedStreamRes.uploader === 'string' && pipedStreamRes.uploader) {
        creator = pipedStreamRes.uploader;
      }
      const audioStreams = Array.isArray(pipedStreamRes.audioStreams)
        ? (pipedStreamRes.audioStreams as Array<{ url?: string; bitrate?: number }>)
        : [];
      const videoStreams = Array.isArray(pipedStreamRes.videoStreams)
        ? (pipedStreamRes.videoStreams as Array<{
            url?: string;
            videoOnly?: boolean;
            quality?: string;
          }>)
        : [];
      const bestAudio = audioStreams.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];
      const bestMuxedVideo =
        videoStreams.find((v) => !v.videoOnly && v.url) ?? videoStreams.find((v) => v.url);
      if (bestAudio?.url && isSafeExternalHttpUrl(bestAudio.url)) {
        directAudioUrl = bestAudio.url;
        extractorNote = 'Piped audio + video streams ready for FFmpeg conversion';
      }
      if (bestMuxedVideo?.url && isSafeExternalHttpUrl(bestMuxedVideo.url)) {
        directVideoUrl = bestMuxedVideo.url;
      }
    }

    if (innerTubeRes.directVideoUrl || innerTubeRes.directAudioUrl) {
      if (innerTubeRes.title && title.startsWith('YouTube Video')) title = innerTubeRes.title;
      if (innerTubeRes.creator && creator === 'YouTube Creator') creator = innerTubeRes.creator;
      if (!durationSec && innerTubeRes.durationSec) durationSec = innerTubeRes.durationSec;
      if (!directVideoUrl && innerTubeRes.directVideoUrl) directVideoUrl = innerTubeRes.directVideoUrl;
      if (!directAudioUrl && innerTubeRes.directAudioUrl) directAudioUrl = innerTubeRes.directAudioUrl;
      extractorNote = 'YouTube InnerTube streams extracted for FFmpeg conversion';
    }

    if (invidiousRes.directVideoUrl || invidiousRes.directAudioUrl || invidiousRes.title) {
      if (invidiousRes.title && title.startsWith('YouTube Video')) title = invidiousRes.title;
      if (invidiousRes.creator && creator === 'YouTube Creator') creator = invidiousRes.creator;
      if (!durationSec && invidiousRes.durationSec) durationSec = invidiousRes.durationSec;
      if (!directVideoUrl && invidiousRes.directVideoUrl) directVideoUrl = invidiousRes.directVideoUrl;
      if (!directAudioUrl && invidiousRes.directAudioUrl) directAudioUrl = invidiousRes.directAudioUrl;
      if (invidiousRes.directVideoUrl || invidiousRes.directAudioUrl) {
        extractorNote = 'Invidious direct streams ready for FFmpeg conversion';
      }
    }

    if (!directVideoUrl && cobaltVid.url) {
      directVideoUrl = cobaltVid.url;
      extractorNote = 'Cobalt direct stream resolved';
    }
    if (!directAudioUrl && cobaltAud.url) {
      directAudioUrl = cobaltAud.url;
    }

    const transcriptText = transcriptSegments.map((s) => s.text).join(' ');

    return {
      id: `yt-${videoId}`,
      title,
      creator,
      platform: 'youtube',
      kind: 'video',
      durationSec,
      durationLabel: durationSec > 0 ? formatDuration(durationSec) : 'YOUTUBE',
      thumbnailUrl,
      sourceUrl: canonicalWatch,
      previewStreamUrl: directAudioUrl || directVideoUrl,
      directVideoUrl,
      directAudioUrl,
      embedPlayerUrl: `https://www.youtube-nocookie.com/embed/${videoId}?rel=0`,
      description,
      keywords,
      transcriptText,
      transcriptSegments,
      formats: buildDefaultFormatMatrix({
        kind: 'video',
        hasTranscript: transcriptSegments.length > 0,
        directVideoUrl,
        directAudioUrl,
        hasThumbnail: true,
      }),
      extractorNote:
        directVideoUrl || directAudioUrl
          ? extractorNote
          : 'YouTube metadata + embed ready · Device Edge Node probing for direct stream',
    };
  }

  // 2. Direct Media URL (mp4, m4v, webm, m4a, mp3, wav, flac, ogg, m3u8, png, jpg, webp)
  const pathname = safeUrl.pathname.toLowerCase();
  const isDirectAudio = /\.(mp3|m4a|wav|flac|ogg|aac)(\?|$)/i.test(pathname);
  const isDirectVideo = /\.(mp4|m4v|webm|mkv|mov|m3u8)(\?|$)/i.test(pathname);
  const isDirectImage = /\.(png|jpe?g|webp|gif)(\?|$)/i.test(pathname);

  if (isDirectAudio || isDirectVideo || isDirectImage) {
    let fileSizeBytes: number | undefined;
    try {
      const head = await fetchWithTimeout(urlStr, { method: 'HEAD' }, 3500);
      const cl = head.headers.get('content-length');
      if (cl) fileSizeBytes = Number.parseInt(cl, 10) || undefined;
    } catch {
      // ignore
    }
    const kind: MediaKind = isDirectImage ? 'image' : isDirectAudio ? 'audio' : 'video';
    const fileName = decodeURIComponent(path.basename(safeUrl.pathname) || 'Direct Media');
    return {
      id: `direct-${crypto.createHash('md5').update(urlStr).digest('hex').slice(0, 10)}`,
      title: fileName.replace(/\.[a-z0-9]+$/i, ''),
      creator: safeUrl.hostname,
      platform: platform === 'itunes' ? 'itunes' : 'direct',
      kind,
      durationSec: isDirectAudio || isDirectVideo ? 30 : 0,
      durationLabel: isDirectAudio || isDirectVideo ? 'STREAM' : 'DIRECT',
      thumbnailUrl: isDirectImage ? urlStr : '',
      sourceUrl: urlStr,
      previewStreamUrl: pathname.endsWith('.m3u8') ? undefined : urlStr,
      directVideoUrl: isDirectVideo ? urlStr : undefined,
      directAudioUrl: isDirectAudio ? urlStr : isDirectVideo ? urlStr : undefined,
      streamIsHls: pathname.endsWith('.m3u8'),
      description: `Direct ${kind} stream from ${safeUrl.hostname}`,
      keywords: [kind, safeUrl.hostname],
      transcriptText: '',
      transcriptSegments: [],
      fileSizeBytes,
      formats: buildDefaultFormatMatrix({
        kind,
        hasTranscript: false,
        directVideoUrl: isDirectVideo ? urlStr : undefined,
        directAudioUrl: isDirectAudio ? urlStr : isDirectVideo ? urlStr : undefined,
        hasThumbnail: isDirectImage,
      }),
      extractorNote: 'Direct stream verified · Ready for streaming & FFmpeg transcoding',
    };
  }

  // 2b. TikTok HD No-Watermark Extractor via TikWM + oEmbed
  if (platform === 'tiktok') {
    try {
      const tikResp = await fetchWithTimeout(
        `https://www.tikwm.com/api/?url=${encodeURIComponent(urlStr)}`,
        {},
        5500
      );
      if (tikResp.ok) {
        const tikJson = (await tikResp.json()) as {
          code?: number;
          data?: {
            id?: string;
            title?: string;
            cover?: string;
            origin_cover?: string;
            duration?: number;
            play?: string;
            hdplay?: string;
            music?: string;
            author?: { nickname?: string; unique_id?: string };
          };
        };
        if (tikJson.code === 0 && tikJson.data) {
          const d = tikJson.data;
          const directVideoUrl = d.hdplay || d.play;
          const directAudioUrl = d.music || d.play;
          const thumbnailUrl = d.origin_cover || d.cover || '';
          const durationSec = Math.max(0, Number(d.duration ?? 0));
          return {
            id: `tiktok-${d.id ?? crypto.randomUUID().slice(0, 8)}`,
            title: d.title || 'TikTok Video',
            creator: d.author?.nickname || d.author?.unique_id || 'TikTok Creator',
            platform: 'tiktok',
            kind: 'video',
            durationSec,
            durationLabel: durationSec > 0 ? formatDuration(durationSec) : 'TIKTOK',
            thumbnailUrl,
            sourceUrl: urlStr,
            previewStreamUrl: directVideoUrl || directAudioUrl,
            directVideoUrl,
            directAudioUrl,
            description: d.title || 'TikTok HD No-Watermark stream',
            keywords: ['tiktok', 'reels', 'mp4'],
            transcriptText: '',
            transcriptSegments: [],
            formats: buildDefaultFormatMatrix({
              kind: 'video',
              hasTranscript: false,
              directVideoUrl,
              directAudioUrl,
              hasThumbnail: Boolean(thumbnailUrl),
            }),
            extractorNote: 'TikTok HD No-Watermark stream ready for streaming & FFmpeg conversion',
          };
        }
      }
    } catch {
      // Fall through to generic oEmbed + OpenGraph + Cobalt
    }
  }

  // 2c. Vimeo Direct Progressive MP4 & HLS Extractor
  if (platform === 'vimeo') {
    const vimeoIdMatch = safeUrl.pathname.match(/\/(\d{5,14})/);
    if (vimeoIdMatch?.[1]) {
      try {
        const cfgResp = await fetchWithTimeout(
          `https://player.vimeo.com/video/${vimeoIdMatch[1]}/config`,
          {},
          5000
        );
        if (cfgResp.ok) {
          const cfg = (await cfgResp.json()) as {
            video?: {
              title?: string;
              duration?: number;
              thumbs?: Record<string, string>;
              owner?: { name?: string };
            };
            request?: {
              files?: {
                progressive?: Array<{ url?: string; width?: number; quality?: string }>;
                hls?: {
                  default_cdn?: string;
                  cdns?: Record<string, { url?: string }>;
                };
              };
            };
          };
          const prog = (cfg.request?.files?.progressive ?? [])
            .filter((p) => Boolean(p.url))
            .sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
          const defCdn = cfg.request?.files?.hls?.default_cdn;
          const allHlsUrls = [
            defCdn ? cfg.request?.files?.hls?.cdns?.[defCdn]?.url : undefined,
            ...Object.values(cfg.request?.files?.hls?.cdns ?? {}).map((c) => c?.url),
          ].filter((u): u is string => Boolean(u));
          const clearHlsUrl = allHlsUrls.find((u) => !/\/drm\/|cbcs/i.test(u));
          const bestVideo = prog[0]?.url || clearHlsUrl;
          const durationSec = Math.max(0, Number(cfg.video?.duration ?? 0));
          const thumb =
            cfg.video?.thumbs?.['1280'] ||
            cfg.video?.thumbs?.['960'] ||
            cfg.video?.thumbs?.['640'] ||
            Object.values(cfg.video?.thumbs ?? {})[0] ||
            '';
          const safeBestVideo = bestVideo && isSafeExternalHttpUrl(bestVideo) ? bestVideo : undefined;
          return {
            id: `vimeo-${vimeoIdMatch[1]}`,
            title: cfg.video?.title || `Vimeo Video (${vimeoIdMatch[1]})`,
            creator: cfg.video?.owner?.name || 'Vimeo Creator',
            platform: 'vimeo',
            kind: 'video',
            durationSec,
            durationLabel: durationSec > 0 ? formatDuration(durationSec) : 'VIMEO',
            thumbnailUrl: thumb,
            sourceUrl: urlStr,
            previewStreamUrl: prog[0]?.url || undefined,
            directVideoUrl: safeBestVideo,
            directAudioUrl: safeBestVideo,
            embedPlayerUrl: `https://player.vimeo.com/video/${vimeoIdMatch[1]}`,
            streamIsHls: !prog[0]?.url && Boolean(safeBestVideo && clearHlsUrl),
            description: cfg.video?.title || 'Vimeo HD stream',
            keywords: ['vimeo', 'hd', 'video'],
            transcriptText: '',
            transcriptSegments: [],
            formats: buildDefaultFormatMatrix({
              kind: 'video',
              hasTranscript: false,
              directVideoUrl: safeBestVideo,
              directAudioUrl: safeBestVideo,
              hasThumbnail: Boolean(thumb),
            }),
            extractorNote: prog[0]?.url
              ? 'Vimeo Progressive MP4 stream ready'
              : safeBestVideo
                ? 'Vimeo HLS stream ready for FFmpeg MP4/MP3 transcoding'
                : 'Vimeo embed & cover ready (DRM-protected CDN stream on this clip; device edge node & thumbnail active)',
          };
        }
      } catch {
        // Fall through
      }
    }
  }

  // 2d. Dailymotion Player Metadata Extractor
  if (platform === 'dailymotion') {
    const dmMatch =
      safeUrl.pathname.match(/\/video\/([a-z0-9]+)/i) ??
      safeUrl.pathname.match(/^\/([a-z0-9]{5,12})$/i);
    if (dmMatch?.[1]) {
      try {
        const dmResp = await fetchWithTimeout(
          `https://www.dailymotion.com/player/metadata/video/${dmMatch[1]}`,
          {},
          5000
        );
        if (dmResp.ok) {
          const dm = (await dmResp.json()) as {
            title?: string;
            duration?: number;
            owner?: { screenname?: string };
            posters?: Record<string, string>;
            qualities?: Record<string, Array<{ url?: string; type?: string }>>;
          };
          const autoStream = dm.qualities?.auto?.[0]?.url;
          const durationSec = Math.max(0, Number(dm.duration ?? 0));
          const thumb =
            dm.posters?.['720'] || dm.posters?.['480'] || Object.values(dm.posters ?? {})[0] || '';
          if (autoStream && isSafeExternalHttpUrl(autoStream)) {
            return {
              id: `dm-${dmMatch[1]}`,
              title: dm.title || `Dailymotion (${dmMatch[1]})`,
              creator: dm.owner?.screenname || 'Dailymotion',
              platform: 'dailymotion',
              kind: 'video',
              durationSec,
              durationLabel: durationSec > 0 ? formatDuration(durationSec) : 'DM',
              thumbnailUrl: thumb,
              sourceUrl: urlStr,
              directVideoUrl: autoStream,
              directAudioUrl: autoStream,
              embedPlayerUrl: `https://www.dailymotion.com/embed/video/${dmMatch[1]}`,
              streamIsHls: autoStream.includes('.m3u8'),
              description: dm.title || 'Dailymotion stream',
              keywords: ['dailymotion', 'video'],
              transcriptText: '',
              transcriptSegments: [],
              formats: buildDefaultFormatMatrix({
                kind: 'video',
                hasTranscript: false,
                directVideoUrl: autoStream,
                directAudioUrl: autoStream,
                hasThumbnail: Boolean(thumb),
              }),
              extractorNote: 'Dailymotion stream ready for FFmpeg conversion',
            };
          }
        }
      } catch {
        // Fall through
      }
    }
  }

  // 2e. Reddit Public JSON Video Extractor
  if (platform === 'reddit' && safeUrl.pathname.includes('/comments/')) {
    try {
      const jsonUrl = `${safeUrl.origin}${safeUrl.pathname.replace(/\/+$/, '')}.json`;
      const rdResp = await fetchWithTimeout(jsonUrl, {}, 4500);
      if (rdResp.ok) {
        const rdJson = (await rdResp.json()) as Array<{
          data?: {
            children?: Array<{
              data?: {
                title?: string;
                author?: string;
                thumbnail?: string;
                secure_media?: { reddit_video?: { fallback_url?: string; duration?: number } };
              };
            }>;
          };
        }>;
        const post = rdJson?.[0]?.data?.children?.[0]?.data;
        const rv = post?.secure_media?.reddit_video;
        if (rv?.fallback_url && isSafeExternalHttpUrl(rv.fallback_url)) {
          const durationSec = Math.max(0, Number(rv.duration ?? 0));
          const thumb = post?.thumbnail?.startsWith('http') ? post.thumbnail : '';
          return {
            id: `reddit-${crypto.createHash('md5').update(urlStr).digest('hex').slice(0, 8)}`,
            title: post?.title || 'Reddit Video',
            creator: post?.author ? `u/${post.author}` : 'Reddit',
            platform: 'reddit',
            kind: 'video',
            durationSec,
            durationLabel: durationSec > 0 ? formatDuration(durationSec) : 'REDDIT',
            thumbnailUrl: thumb,
            sourceUrl: urlStr,
            previewStreamUrl: rv.fallback_url,
            directVideoUrl: rv.fallback_url,
            directAudioUrl: rv.fallback_url,
            description: post?.title || 'Reddit MP4 video stream',
            keywords: ['reddit', 'mp4'],
            transcriptText: '',
            transcriptSegments: [],
            formats: buildDefaultFormatMatrix({
              kind: 'video',
              hasTranscript: false,
              directVideoUrl: rv.fallback_url,
              directAudioUrl: rv.fallback_url,
              hasThumbnail: Boolean(thumb),
            }),
            extractorNote: 'Reddit MP4 stream ready for download & conversion',
          };
        }
      }
    } catch {
      // Fall through
    }
  }

  // 2f. Audius Track / Playlist Resolver (100% Open Keyless Full-Length Streams + Slug Search Fallback)
  if (platform === 'audius') {
    const mapAudiusTrackResult = (
      firstTrack: AudiusTrack,
      playlistTitle?: string,
      tracksList?: AudiusTrack[],
      note = 'Audius full-length stream ready (MP3 / WAV / FLAC)'
    ): MediaInspectResult => {
      const trackId = firstTrack.id;
      const streamUrl = trackId
        ? `https://api.audius.co/v1/tracks/${encodeURIComponent(trackId)}/stream?app_name=BLUEDROP`
        : undefined;
      const thumb =
        firstTrack.artwork?.['480x480'] ||
        firstTrack.artwork?.['1000x1000'] ||
        '';
      const durationSec = Math.max(0, Number(firstTrack.duration ?? 0));
      const playlistItems: MediaSearchItem[] = (tracksList ?? [])
        .filter((t) => Boolean(t.id && t.title))
        .slice(0, 20)
        .map((t) => ({
          id: `audius-${t.id}`,
          title: t.title!,
          creator: t.user?.name || 'Audius Artist',
          platform: 'audius',
          kind: 'audio',
          durationSec: Math.max(0, Number(t.duration ?? 0)),
          durationLabel: t.duration ? formatDuration(t.duration) : 'TRACK',
          thumbnailUrl: t.artwork?.['480x480'] || thumb,
          sourceUrl: t.permalink ? `https://audius.co${t.permalink}` : urlStr,
          previewStreamUrl: `https://api.audius.co/v1/tracks/${encodeURIComponent(t.id!)}/stream?app_name=BLUEDROP`,
        }));

      return {
        id: `audius-${trackId ?? crypto.createHash('md5').update(urlStr).digest('hex').slice(0, 8)}`,
        title: playlistTitle || firstTrack.title || 'Audius Track',
        creator: firstTrack.user?.name || firstTrack.user?.handle || 'Audius Artist',
        platform: 'audius',
        kind: 'audio',
        durationSec,
        durationLabel: durationSec > 0 ? formatDuration(durationSec) : 'FULL TRACK',
        thumbnailUrl: thumb,
        sourceUrl: urlStr,
        previewStreamUrl: streamUrl,
        directAudioUrl: streamUrl,
        playlistItems: playlistItems.length > 0 ? playlistItems : undefined,
        description: `Full-length Audius audio stream (${firstTrack.genre || 'Music'})`,
        keywords: ['audius', firstTrack.genre || 'music', 'mp3'],
        transcriptText: '',
        transcriptSegments: [],
        formats: buildDefaultFormatMatrix({
          kind: 'audio',
          hasTranscript: false,
          directAudioUrl: streamUrl,
          hasThumbnail: Boolean(thumb),
        }),
        extractorNote: note,
      };
    };

    try {
      const resResp = await fetchWithTimeout(
        `https://api.audius.co/v1/resolve?url=${encodeURIComponent(urlStr)}&app_name=BLUEDROP`,
        {},
        5000
      );
      if (resResp.ok) {
        const json = (await resResp.json()) as {
          data?: AudiusTrack & { playlist_name?: string; tracks?: AudiusTrack[] };
        };
        const d = json.data;
        if (d) {
          const firstTrack = d.tracks?.[0] ?? d;
          return mapAudiusTrackResult(firstTrack, d.playlist_name, d.tracks);
        }
      }
    } catch {
      // Try slug search fallback below
    }

    // Fallback: search Audius by permalink (artist + track slug, then track slug alone)
    try {
      const parts = safeUrl.pathname.split('/').filter(Boolean);
      const rawSlug = parts[parts.length - 1] ?? parts[0] ?? '';
      const slugWords = decodeURIComponent(rawSlug)
        .replace(/-\d+$/, '')
        .replace(/[-_]+/g, ' ')
        .trim();
      const artistHint = parts.length >= 2 ? parts[0]!.replace(/[-_]+/g, ' ') : '';
      const candidates = Array.from(
        new Set([
          [slugWords, artistHint].filter(Boolean).join(' ').trim(),
          slugWords,
        ].filter(Boolean))
      );
      for (const q of candidates) {
        const sr = await fetchWithTimeout(
          `https://api.audius.co/v1/tracks/search?query=${encodeURIComponent(q)}&app_name=BLUEDROP&limit=4`,
          {},
          5000
        );
        if (!sr.ok) continue;
        const sj = (await sr.json()) as { data?: AudiusTrack[] };
        const tracks = Array.isArray(sj.data) ? sj.data.filter((t) => Boolean(t.id && t.title)) : [];
        if (tracks[0]) {
          return mapAudiusTrackResult(
            tracks[0],
            undefined,
            tracks.length > 1 ? tracks : undefined,
            'Audius matched via open catalog search (MP3 / WAV / FLAC)'
          );
        }
      }
    } catch {
      // Return clean audio stub rather than falling back to image
    }

    const parts = safeUrl.pathname.split('/').filter(Boolean);
    const fallbackTitle =
      decodeURIComponent(parts[parts.length - 1] ?? 'Audius Audio')
        .replace(/-\d+$/, '')
        .replace(/[-_]+/g, ' ')
        .trim() || 'Audius Audio';
    return {
      id: `audius-${crypto.createHash('md5').update(urlStr).digest('hex').slice(0, 8)}`,
      title: fallbackTitle,
      creator: parts[0] || 'Audius Artist',
      platform: 'audius',
      kind: 'audio',
      durationSec: 0,
      durationLabel: 'AUDIO',
      thumbnailUrl: '',
      sourceUrl: urlStr,
      description: 'Audius audio link — ready for open search or local conversion',
      keywords: ['audius', 'audio', 'mp3'],
      transcriptText: '',
      transcriptSegments: [],
      formats: buildDefaultFormatMatrix({
        kind: 'audio',
        hasTranscript: false,
        hasThumbnail: false,
      }),
      extractorNote: 'Audius track permalink preserved as audio (track unavailable or removed by artist)',
    };
  }

  // 2g. Archive.org Video / Audio / Movie Extractor
  if (platform === 'archive') {
    const idMatch = safeUrl.pathname.match(/\/(?:details|embed|download)\/([^/?#]+)/i);
    if (idMatch?.[1]) {
      try {
        const identifier = decodeURIComponent(idMatch[1]);
        const metaResp = await fetchWithTimeout(
          `https://archive.org/metadata/${encodeURIComponent(identifier)}`,
          {},
          7500
        );
        if (metaResp.ok) {
          const meta = (await metaResp.json()) as {
            metadata?: { title?: string | string[]; creator?: string | string[]; description?: string | string[] };
            files?: Array<{ name?: string; format?: string; length?: string; size?: string }>;
          };
          const files = meta.files ?? [];
          const vidFile =
            files.find((f) => /\.mp4$/i.test(f.name ?? '')) ??
            files.find((f) => /\.(webm|mkv|mov)$/i.test(f.name ?? ''));
          const audFile =
            files.find((f) => /\.(mp3|flac|ogg|m4a|wav)$/i.test(f.name ?? ''));
          const fileUrl = (f?: { name?: string }) =>
            f?.name
              ? `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(f.name).replace(/%2F/g, '/')}`
              : undefined;
          const directVideoUrl = fileUrl(vidFile);
          const directAudioUrl = fileUrl(audFile) || directVideoUrl;
          const kind: MediaKind = vidFile ? 'video' : 'audio';
          const titleRaw = meta.metadata?.title;
          const creatorRaw = meta.metadata?.creator;
          const title = (Array.isArray(titleRaw) ? titleRaw[0] : titleRaw) || identifier;
          const creator = (Array.isArray(creatorRaw) ? creatorRaw[0] : creatorRaw) || 'Internet Archive';
          const thumb = `https://archive.org/services/img/${encodeURIComponent(identifier)}`;
          const durationSec = Math.round(Number.parseFloat((vidFile || audFile)?.length ?? '0') || 0);
          const playlistItems: MediaSearchItem[] = files
            .filter((f) => /\.(mp3|flac|ogg|mp4|webm)$/i.test(f.name ?? ''))
            .slice(0, 16)
            .map((f, idx) => ({
              id: `archive-${identifier}-${idx}`,
              title: (f.name ?? 'Track').replace(/\.[a-z0-9]+$/i, ''),
              creator,
              platform: 'archive',
              kind: /\.(mp3|flac|ogg)$/i.test(f.name ?? '') ? 'audio' : 'video',
              durationSec: Math.round(Number.parseFloat(f.length ?? '0') || 0),
              durationLabel: f.format || 'FILE',
              thumbnailUrl: thumb,
              sourceUrl: fileUrl(f) || urlStr,
              previewStreamUrl: fileUrl(f),
            }));
          if (directVideoUrl || directAudioUrl) {
            return {
              id: `archive-${identifier}`,
              title,
              creator,
              platform: 'archive',
              kind,
              durationSec,
              durationLabel: durationSec > 0 ? formatDuration(durationSec) : 'ARCHIVE',
              thumbnailUrl: thumb,
              sourceUrl: urlStr,
              previewStreamUrl: directAudioUrl || directVideoUrl,
              directVideoUrl,
              directAudioUrl,
              playlistItems: playlistItems.length > 1 ? playlistItems : undefined,
              description: typeof meta.metadata?.description === 'string' ? meta.metadata.description.slice(0, 800) : title,
              keywords: ['archive.org', kind],
              transcriptText: '',
              transcriptSegments: [],
              formats: buildDefaultFormatMatrix({
                kind,
                hasTranscript: false,
                directVideoUrl,
                directAudioUrl,
                hasThumbnail: true,
              }),
              extractorNote: 'Internet Archive direct files extracted & ready for FFmpeg conversion',
            };
          }
        }
      } catch {
        // fall through
      }
    }
  }

  // 2h. Bandcamp Track / Album Extractor (parses data-tralbum JSON directly from HTML)
  if (platform === 'bandcamp') {
    try {
      const bcResp = await fetchWithTimeout(urlStr, {}, 5000);
      if (bcResp.ok) {
        const html = await bcResp.text();
        const attrMatch = html.match(/data-tralbum="([^"]+)"/i);
        if (attrMatch?.[1]) {
          const decoded = decodeHtmlEntities(attrMatch[1]);
          const tralbum = JSON.parse(decoded) as {
            artist?: string;
            current?: { title?: string; art_id?: number };
            art_id?: number;
            trackinfo?: Array<{
              title?: string;
              duration?: number;
              file?: { 'mp3-128'?: string };
              title_link?: string;
            }>;
          };
          const tracks = (tralbum.trackinfo ?? []).filter((t) => Boolean(t.file?.['mp3-128']));
          const artId = tralbum.current?.art_id ?? tralbum.art_id;
          const thumb = artId ? `https://f4.bcbits.com/img/a${artId}_10.jpg` : '';
          const first = tracks[0];
          if (first?.file?.['mp3-128']) {
            const directAudioUrl = first.file['mp3-128'];
            const durationSec = Math.round(first.duration ?? 0);
            const playlistItems: MediaSearchItem[] = tracks.slice(0, 20).map((t, i) => ({
              id: `bc-${i}-${crypto.createHash('md5').update(t.title ?? String(i)).digest('hex').slice(0, 6)}`,
              title: t.title || `Track ${i + 1}`,
              creator: tralbum.artist || 'Bandcamp Artist',
              platform: 'bandcamp',
              kind: 'audio',
              durationSec: Math.round(t.duration ?? 0),
              durationLabel: t.duration ? formatDuration(t.duration) : 'MP3',
              thumbnailUrl: thumb,
              sourceUrl: t.title_link ? `${safeUrl.origin}${t.title_link}` : urlStr,
              previewStreamUrl: t.file?.['mp3-128'],
            }));
            return {
              id: `bc-${crypto.createHash('md5').update(urlStr).digest('hex').slice(0, 10)}`,
              title: tralbum.current?.title || first.title || 'Bandcamp Release',
              creator: tralbum.artist || 'Bandcamp Artist',
              platform: 'bandcamp',
              kind: 'audio',
              durationSec,
              durationLabel: durationSec > 0 ? formatDuration(durationSec) : 'BANDCAMP',
              thumbnailUrl: thumb,
              sourceUrl: urlStr,
              previewStreamUrl: directAudioUrl,
              directAudioUrl,
              playlistItems: playlistItems.length > 1 ? playlistItems : undefined,
              description: `${tralbum.artist || 'Bandcamp'} — ${tracks.length} streamable track(s)`,
              keywords: ['bandcamp', 'album', 'mp3'],
              transcriptText: '',
              transcriptSegments: [],
              formats: buildDefaultFormatMatrix({
                kind: 'audio',
                hasTranscript: false,
                directAudioUrl,
                hasThumbnail: Boolean(thumb),
              }),
              extractorNote: `Bandcamp ${tracks.length > 1 ? `Album (${tracks.length} tracks)` : 'Track'} extracted directly`,
            };
          }
        }
      }
    } catch {
      // fall through
    }
  }

  // 2i. SoundCloud Anonymous client_id Scraper + Transcoding Resolver
  if (platform === 'soundcloud') {
    try {
      const scHtmlResp = await fetchWithTimeout(urlStr, {}, 5000);
      if (scHtmlResp.ok) {
        const html = await scHtmlResp.text();
        const hydMatch = html.match(/window\.__sc_hydration\s*=\s*(\[[\s\S]*?\]);<\/script>/);
        let scTitle = '';
        let scArtist = '';
        let scThumb = '';
        let scDuration = 0;
        let transcodings: Array<{ url?: string; format?: { protocol?: string; mime_type?: string } }> = [];

        if (hydMatch?.[1]) {
          const hyd = JSON.parse(hydMatch[1]) as Array<{
            hydratable?: string;
            data?: {
              title?: string;
              duration?: number;
              artwork_url?: string;
              user?: { username?: string };
              media?: { transcodings?: typeof transcodings };
            };
          }>;
          const sound = hyd.find((h) => h.hydratable === 'sound')?.data;
          if (sound) {
            scTitle = sound.title || '';
            scArtist = sound.user?.username || '';
            scThumb = (sound.artwork_url || '').replace('-large', '-t500x500');
            scDuration = Math.round((sound.duration ?? 0) / 1000);
            transcodings = sound.media?.transcodings ?? [];
          }
        }

        let directAudioUrl: string | undefined;
        if (transcodings.length > 0) {
          // Discover ephemeral SoundCloud client_id from public JS bundle
          const scriptUrls = Array.from(
            html.matchAll(/src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)
          ).map((m) => m[1]);
          let clientId = '';
          for (const jsUrl of scriptUrls.slice(-4)) {
            if (!jsUrl) continue;
            try {
              const jsTxt = await (await fetchWithTimeout(jsUrl, {}, 3500)).text();
              const cid = jsTxt.match(/client_id\s*:\s*["']([a-zA-Z0-9]{20,40})["']/);
              if (cid?.[1]) {
                clientId = cid[1];
                break;
              }
            } catch {
              // next script
            }
          }
          if (clientId) {
            const preferred =
              transcodings.find((t) => t.format?.protocol === 'progressive') ?? transcodings[0];
            if (preferred?.url) {
              const sep = preferred.url.includes('?') ? '&' : '?';
              const trResp = await fetchWithTimeout(
                `${preferred.url}${sep}client_id=${encodeURIComponent(clientId)}`,
                {},
                4000
              ).catch(() => null);
              if (trResp?.ok) {
                const trJson = (await trResp.json()) as { url?: string };
                if (trJson.url && isSafeExternalHttpUrl(trJson.url)) {
                  directAudioUrl = trJson.url;
                }
              }
            }
          }
        }

        if (directAudioUrl) {
          return {
            id: `sc-${crypto.createHash('md5').update(urlStr).digest('hex').slice(0, 10)}`,
            title: scTitle || 'SoundCloud Track',
            creator: scArtist || 'SoundCloud',
            platform: 'soundcloud',
            kind: 'audio',
            durationSec: scDuration,
            durationLabel: scDuration > 0 ? formatDuration(scDuration) : 'SOUNDCLOUD',
            thumbnailUrl: scThumb,
            sourceUrl: urlStr,
            previewStreamUrl: directAudioUrl.includes('.m3u8') ? undefined : directAudioUrl,
            directAudioUrl,
            streamIsHls: directAudioUrl.includes('.m3u8'),
            description: `${scTitle} by ${scArtist}`,
            keywords: ['soundcloud', 'music', 'mp3'],
            transcriptText: '',
            transcriptSegments: [],
            formats: buildDefaultFormatMatrix({
              kind: 'audio',
              hasTranscript: false,
              directAudioUrl,
              hasThumbnail: Boolean(scThumb),
            }),
            extractorNote: 'SoundCloud direct audio stream resolved via transcoding bot',
          };
        }
      }
    } catch {
      // fall through
    }
  }

  // 2j. Spotify Link Bridge Bot (spotDL-style zero-key resolver: Spotify metadata -> Audius/Invidious/iTunes stream)
  if (platform === 'spotify') {
    try {
      const spResp = await fetchWithTimeout(
        `https://open.spotify.com/oembed?url=${encodeURIComponent(urlStr)}`,
        {},
        4500
      );
      if (spResp.ok) {
        const oe = (await spResp.json()) as { title?: string; thumbnail_url?: string };
        const cleanTitle = (oe.title || '').replace(/\s*-\s*song and lyrics by\s*/i, ' ').trim();
        if (cleanTitle) {
          const searchOut = await searchMedia(cleanTitle, 'music');
          const matches = searchOut.items;
          const bestMatch = matches.find((m) => Boolean(m.previewStreamUrl)) ?? matches[0];
          let resolvedStream = bestMatch?.previewStreamUrl;
          const resolvedCreator = bestMatch?.creator || 'Spotify Bridge';
          if (!resolvedStream && bestMatch?.sourceUrl && bestMatch.platform === 'youtube') {
            const vidId = extractYouTubeVideoId(bestMatch.sourceUrl);
            if (vidId) {
              const inv = await resolveYouTubeInvidious(vidId);
              resolvedStream = inv.directAudioUrl || inv.directVideoUrl;
            }
          }
          return {
            id: `sp-${crypto.createHash('md5').update(urlStr).digest('hex').slice(0, 10)}`,
            title: oe.title || cleanTitle,
            creator: resolvedCreator,
            platform: 'spotify',
            kind: 'audio',
            durationSec: bestMatch?.durationSec || 0,
            durationLabel: bestMatch?.durationLabel || 'SPOTIFY',
            thumbnailUrl: oe.thumbnail_url || bestMatch?.thumbnailUrl || '',
            sourceUrl: urlStr,
            previewStreamUrl: resolvedStream,
            directAudioUrl: resolvedStream,
            playlistItems: matches.slice(0, 8),
            description: `Spotify bridge resolved "${cleanTitle}" via open audio networks`,
            keywords: ['spotify', 'music', 'mp3'],
            transcriptText: '',
            transcriptSegments: [],
            formats: buildDefaultFormatMatrix({
              kind: 'audio',
              hasTranscript: false,
              directAudioUrl: resolvedStream,
              hasThumbnail: Boolean(oe.thumbnail_url || bestMatch?.thumbnailUrl),
            }),
            extractorNote: resolvedStream
              ? 'Spotify Bridge Bot matched playable stream -> Ready for MP3/WAV/FLAC'
              : 'Spotify metadata matched; select a bridge source below or inspect matching track',
          };
        }
      }
    } catch {
      // fall through
    }
  }

  // 2k. X / Twitter Video Bot (FxTwitter & VxTwitter JSON APIs)
  if (platform === 'x') {
    const statusMatch = safeUrl.pathname.match(/\/([^/]+)\/status\/(\d+)/i);
    if (statusMatch?.[2]) {
      for (const apiBase of ['https://api.fxtwitter.com', 'https://api.vxtwitter.com']) {
        try {
          const xr = await fetchWithTimeout(`${apiBase}${safeUrl.pathname}`, {}, 4500);
          if (!xr.ok) continue;
          const xj = (await xr.json()) as {
            tweet?: {
              text?: string;
              author?: { name?: string; screen_name?: string };
              media?: {
                videos?: Array<{ url?: string; thumbnail_url?: string; duration?: number }>;
                photos?: Array<{ url?: string }>;
              };
            };
            text?: string;
            user_name?: string;
            media_extended?: Array<{ url?: string; thumbnail_url?: string; type?: string; duration_millis?: number }>;
          };
          const fxVid = xj.tweet?.media?.videos?.[0];
          const vxVid = xj.media_extended?.find((m) => m.type === 'video' || m.type === 'gif');
          const vidUrl = fxVid?.url || vxVid?.url;
          const thumb = fxVid?.thumbnail_url || vxVid?.thumbnail_url || xj.tweet?.media?.photos?.[0]?.url || '';
          const title = (xj.tweet?.text || xj.text || 'X Post Media').slice(0, 120);
          const creator = xj.tweet?.author?.name || xj.user_name || 'X Creator';
          const durationSec = Math.round(
            fxVid?.duration ?? ((vxVid?.duration_millis ?? 0) / 1000)
          );
          if (vidUrl && isSafeExternalHttpUrl(vidUrl)) {
            return {
              id: `x-${statusMatch[2]}`,
              title,
              creator,
              platform: 'x',
              kind: 'video',
              durationSec,
              durationLabel: durationSec > 0 ? formatDuration(durationSec) : 'X HD',
              thumbnailUrl: thumb,
              sourceUrl: urlStr,
              previewStreamUrl: vidUrl,
              directVideoUrl: vidUrl,
              directAudioUrl: vidUrl,
              description: xj.tweet?.text || xj.text || title,
              keywords: ['x', 'twitter', 'mp4'],
              transcriptText: '',
              transcriptSegments: [],
              formats: buildDefaultFormatMatrix({
                kind: 'video',
                hasTranscript: false,
                directVideoUrl: vidUrl,
                directAudioUrl: vidUrl,
                hasThumbnail: Boolean(thumb),
              }),
              extractorNote: 'X / Twitter HD MP4 extracted cleanly',
            };
          }
        } catch {
          // try next Twitter JSON mirror
        }
      }

      // Syndication fallback if FxTwitter / VxTwitter are rate-limited
      try {
        const synResp = await fetchWithTimeout(
          `https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(statusMatch[2])}&token=x`,
          {},
          4500
        );
        if (synResp.ok) {
          const sj = (await synResp.json()) as {
            text?: string;
            user?: { name?: string; screen_name?: string };
            video?: {
              poster?: string;
              durationMs?: number;
              variants?: Array<{ type?: string; src?: string }>;
            };
          };
          const mp4Var = sj.video?.variants
            ?.filter((v) => v.type === 'video/mp4' && v.src && isSafeExternalHttpUrl(v.src))
            .pop();
          if (mp4Var?.src) {
            const durationSec = Math.round((sj.video?.durationMs ?? 0) / 1000);
            const thumb = sj.video?.poster || '';
            return {
              id: `x-${statusMatch[2]}`,
              title: (sj.text || 'X Video').slice(0, 120),
              creator: sj.user?.name || sj.user?.screen_name || 'X Creator',
              platform: 'x',
              kind: 'video',
              durationSec,
              durationLabel: durationSec > 0 ? formatDuration(durationSec) : 'X HD',
              thumbnailUrl: thumb,
              sourceUrl: urlStr,
              previewStreamUrl: mp4Var.src,
              directVideoUrl: mp4Var.src,
              directAudioUrl: mp4Var.src,
              description: sj.text || 'X Video HD MP4',
              keywords: ['x', 'twitter', 'mp4'],
              transcriptText: '',
              transcriptSegments: [],
              formats: buildDefaultFormatMatrix({
                kind: 'video',
                hasTranscript: false,
                directVideoUrl: mp4Var.src,
                directAudioUrl: mp4Var.src,
                hasThumbnail: Boolean(thumb),
              }),
              extractorNote: 'X / Twitter Syndication HD MP4 extracted cleanly',
            };
          }
        }
      } catch {
        // fall through to generic scraper
      }
    }
  }

  // 2l. Streamable Direct MP4 Extractor
  if (platform === 'streamable') {
    const code = safeUrl.pathname.replace(/^\/+/, '').split('/')[0];
    if (code) {
      try {
        const sr = await fetchWithTimeout(`https://api.streamable.com/videos/${encodeURIComponent(code)}`, {}, 4500);
        if (sr.ok) {
          const sj = (await sr.json()) as {
            title?: string;
            thumbnail_url?: string;
            files?: { mp4?: { url?: string; duration?: number }; 'mp4-mobile'?: { url?: string } };
          };
          const vidUrl = sj.files?.mp4?.url || sj.files?.['mp4-mobile']?.url;
          if (vidUrl && isSafeExternalHttpUrl(vidUrl)) {
            const thumb = sj.thumbnail_url?.startsWith('//') ? `https:${sj.thumbnail_url}` : sj.thumbnail_url || '';
            const durationSec = Math.round(sj.files?.mp4?.duration ?? 0);
            return {
              id: `streamable-${code}`,
              title: sj.title || `Streamable (${code})`,
              creator: 'Streamable',
              platform: 'streamable',
              kind: 'video',
              durationSec,
              durationLabel: durationSec > 0 ? formatDuration(durationSec) : 'MP4',
              thumbnailUrl: thumb,
              sourceUrl: urlStr,
              previewStreamUrl: vidUrl,
              directVideoUrl: vidUrl,
              directAudioUrl: vidUrl,
              description: sj.title || 'Streamable direct MP4',
              keywords: ['streamable', 'mp4'],
              transcriptText: '',
              transcriptSegments: [],
              formats: buildDefaultFormatMatrix({
                kind: 'video',
                hasTranscript: false,
                directVideoUrl: vidUrl,
                directAudioUrl: vidUrl,
                hasThumbnail: Boolean(thumb),
              }),
              extractorNote: 'Streamable HD MP4 stream ready',
            };
          }
        }
      } catch {
        // fall through
      }
    }
  }

  // 3. Universal Deep Scraper & Social Platforms (Instagram, Facebook, Web HTML5, oEmbed + Cobalt)
  const AUDIO_DOMINANT_PLATFORMS = new Set<MediaPlatform>([
    'soundcloud',
    'audius',
    'spotify',
    'bandcamp',
    'itunes',
  ]);
  const VIDEO_OR_AUDIO_HOSTS = new Set<MediaPlatform>([
    'youtube',
    'tiktok',
    'instagram',
    'facebook',
    'x',
    'vimeo',
    'dailymotion',
    'reddit',
    'streamable',
    'audius',
    'soundcloud',
    'spotify',
    'bandcamp',
    'archive',
  ]);

  let title = `${platform.toUpperCase()} Media`;
  let creator = safeUrl.hostname;
  let thumbnailUrl = '';
  let description = '';
  let directVideoUrl: string | undefined;
  let directAudioUrl: string | undefined;
  let embedPlayerUrl: string | undefined;
  let kind: MediaKind = AUDIO_DOMINANT_PLATFORMS.has(platform) ? 'audio' : 'video';

  if (platform === 'vimeo') {
    const vm = safeUrl.pathname.match(/\/(\d{5,})/);
    if (vm?.[1]) embedPlayerUrl = `https://player.vimeo.com/video/${vm[1]}`;
  } else if (platform === 'dailymotion') {
    const dm = safeUrl.pathname.match(/\/video\/([a-zA-Z0-9]+)/i);
    if (dm?.[1]) embedPlayerUrl = `https://www.dailymotion.com/embed/video/${dm[1]}`;
  } else if (platform === 'tiktok') {
    const tm = safeUrl.pathname.match(/\/video\/(\d+)/i);
    if (tm?.[1]) embedPlayerUrl = `https://www.tiktok.com/embed/v2/${tm[1]}`;
  }

  const oembedLookup: Record<string, string> = {
    tiktok: `https://www.tiktok.com/oembed?url=${encodeURIComponent(urlStr)}`,
    vimeo: `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(urlStr)}`,
    soundcloud: `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(urlStr)}`,
  };

  const igEmbedUrl =
    platform === 'instagram'
      ? `${safeUrl.origin}${safeUrl.pathname.replace(/\/+$/, '')}/embed/captioned/`
      : null;

  const [oembedResp, cobaltVid, cobaltAud, pageResp, igEmbedResp] = await Promise.all([
    oembedLookup[platform]
      ? fetchWithTimeout(oembedLookup[platform]!, {}, 3500).catch(() => null)
      : Promise.resolve(null),
    resolveCobaltDirectStream(urlStr, false),
    resolveCobaltDirectStream(urlStr, true),
    fetchWithTimeout(urlStr, {}, 4800).catch(() => null),
    igEmbedUrl ? fetchWithTimeout(igEmbedUrl, {}, 4800).catch(() => null) : Promise.resolve(null),
  ]);

  if (oembedResp?.ok) {
    try {
      const oe = (await oembedResp.json()) as {
        title?: string;
        author_name?: string;
        thumbnail_url?: string;
      };
      if (oe.title) title = oe.title;
      if (oe.author_name) creator = oe.author_name;
      if (oe.thumbnail_url) thumbnailUrl = oe.thumbnail_url;
    } catch {
      // ignore
    }
  }

  const htmlSources: string[] = [];
  for (const candResp of [igEmbedResp, pageResp]) {
    if (candResp?.ok && (candResp.headers.get('content-type') ?? '').includes('text/html')) {
      try {
        htmlSources.push((await candResp.text()).slice(0, 260000));
      } catch {
        // ignore
      }
    }
  }

  let foundExplicitImageTag = false;
  for (const rawHtml of htmlSources) {
    try {
      const html = rawHtml.replace(/\\u0026/g, '&').replace(/\\\//g, '/');
      const extractMeta = (prop: string): string => {
        const m =
          html.match(
            new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i')
          ) ??
          html.match(
            new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, 'i')
          );
        return m?.[1] ? decodeHtmlEntities(m[1]) : '';
      };
      const ogTitle = extractMeta('og:title') || extractMeta('twitter:title');
      const ogDesc = extractMeta('og:description') || extractMeta('description');
      const ogImg = extractMeta('og:image') || extractMeta('twitter:image');
      const ogVid = extractMeta('og:video:secure_url') || extractMeta('og:video');
      const ogAud = extractMeta('og:audio:secure_url') || extractMeta('og:audio');
      if (ogImg) foundExplicitImageTag = true;
      if (ogTitle && (title.startsWith(platform.toUpperCase()) || title.length < 4)) title = ogTitle;
      if (ogDesc && !description) description = ogDesc;
      if (ogImg && !thumbnailUrl) thumbnailUrl = ogImg;

      if (platform === 'instagram') {
        const igThumb = html.match(/<img[^>]+class="[^"]*EmbeddedMediaImage[^"]*"[^>]+src="([^"]+)"/i);
        const igUser =
          html.match(/<span class="UsernameText"[^>]*>([^<]+)<\/span>/i) ??
          html.match(/"username"\s*:\s*"([^"]+)"/i);
        const igCap = html.match(/<div class="Caption"[^>]*>([\s\S]*?)<\/div>/i);
        if (igThumb?.[1] && !thumbnailUrl) thumbnailUrl = decodeHtmlEntities(igThumb[1]);
        if (igUser?.[1] && creator === safeUrl.hostname) creator = decodeHtmlEntities(igUser[1]);
        if (igCap?.[1] && !description) {
          description = decodeHtmlEntities(igCap[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
          if (title.startsWith('INSTAGRAM') && description) title = description.slice(0, 95);
        }
      }

      const jsonVidMatch = html.match(
        /"(?:playable_url_quality_hd|browser_native_hd_url|browser_native_sd_url|hd_src_no_ratelimit|hd_src|sd_src|playable_url|video_url|contentUrl)"\s*:\s*"(https?:[^"]+)"/i
      );
      const rawTagSrc = html.match(/<(?:video|source)[^>]+src=["']([^"']+\.(?:mp4|m4v|webm|m3u8)[^"']*)["']/i);
      const rawAudTag = html.match(/<(?:audio|source)[^>]+src=["']([^"']+\.(?:mp3|m4a|wav|flac|ogg)[^"']*)["']/i);
      const anyCdnMedia = html.match(/https?:\/\/[^\s"'<>\\]+\.(?:mp4|webm|m3u8|mp3|m4a)(?:\?[^\s"'<>\\]*)?/i);

      const cleanCandidate = (u?: string) => (u ? decodeHtmlEntities(u) : '');

      if (!directVideoUrl) {
        for (const cand of [
          cleanCandidate(ogVid),
          cleanCandidate(jsonVidMatch?.[1]),
          cleanCandidate(rawTagSrc?.[1]),
          cleanCandidate(anyCdnMedia?.[0]),
        ]) {
          if (cand && isSafeExternalHttpUrl(cand) && !/\.(html?|php|jsp)(\?|$)/i.test(cand)) {
            directVideoUrl = cand;
            kind = 'video';
            break;
          }
        }
      }
      if (!directAudioUrl) {
        for (const audCand of [cleanCandidate(ogAud), cleanCandidate(rawAudTag?.[1])]) {
          if (audCand && isSafeExternalHttpUrl(audCand)) {
            directAudioUrl = audCand;
            if (!directVideoUrl) kind = 'audio';
            break;
          }
        }
      }
    } catch {
      // ignore
    }
  }

  if (!directVideoUrl && cobaltVid.url) directVideoUrl = cobaltVid.url;
  if (!directAudioUrl && cobaltAud.url) directAudioUrl = cobaltAud.url;

  if (
    !directVideoUrl &&
    !directAudioUrl &&
    foundExplicitImageTag &&
    !VIDEO_OR_AUDIO_HOSTS.has(platform) &&
    !/\.(mp4|webm|mov|mkv|mp3|wav|flac|m4a)(\?|$)/i.test(urlStr)
  ) {
    kind = 'image';
  }

  return {
    id: `${platform}-${crypto.createHash('md5').update(urlStr).digest('hex').slice(0, 10)}`,
    title,
    creator,
    platform,
    kind,
    durationSec: 0,
    durationLabel: 'STREAM',
    thumbnailUrl,
    sourceUrl: urlStr,
    previewStreamUrl: directAudioUrl || directVideoUrl,
    directVideoUrl,
    directAudioUrl,
    embedPlayerUrl,
    description,
    keywords: [platform, kind],
    transcriptText: '',
    transcriptSegments: [],
    formats: buildDefaultFormatMatrix({
      kind,
      hasTranscript: false,
      directVideoUrl,
      directAudioUrl,
      hasThumbnail: Boolean(thumbnailUrl),
    }),
    extractorNote:
      directVideoUrl || directAudioUrl
        ? 'Direct stream extracted · Ready for FFmpeg conversion'
        : embedPlayerUrl
          ? 'Embedded video + cover & device edge resolver ready'
          : 'Metadata & OpenGraph extracted · Ready for device edge / cover conversion',
  };
}

function getMimeForExt(ext: string): string {
  const map: Record<string, string> = {
    mp4: 'video/mp4',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    mov: 'video/quicktime',
    gif: 'image/gif',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    flac: 'audio/flac',
    aac: 'audio/aac',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    srt: 'application/x-subrip; charset=utf-8',
    txt: 'text/plain; charset=utf-8',
  };
  return map[ext.toLowerCase()] ?? 'application/octet-stream';
}

function buildFfmpegArgs(
  inputPath: string,
  outputPath: string,
  formatId: TargetFormatId,
  meta: { title?: string; artist?: string }
): string[] {
  const args = ['-y', '-i', inputPath];

  if (meta.title) {
    args.push('-metadata', `title=${meta.title.slice(0, 120)}`);
  }
  if (meta.artist) {
    args.push('-metadata', `artist=${meta.artist.slice(0, 120)}`);
  }

  switch (formatId) {
    case 'mp3-320':
      args.push('-vn', '-c:a', 'libmp3lame', '-b:a', '320k', '-id3v2_version', '3', outputPath);
      break;
    case 'mp3-192':
      args.push('-vn', '-c:a', 'libmp3lame', '-b:a', '192k', '-id3v2_version', '3', outputPath);
      break;
    case 'wav':
      args.push('-vn', '-c:a', 'pcm_s16le', '-ar', '44100', outputPath);
      break;
    case 'flac':
      args.push('-vn', '-c:a', 'flac', outputPath);
      break;
    case 'aac':
      args.push('-vn', '-c:a', 'aac', '-b:a', '256k', outputPath);
      break;
    case 'ogg':
      args.push('-vn', '-c:a', 'libvorbis', '-q:a', '6', outputPath);
      break;
    case 'm4a':
      args.push('-vn', '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', outputPath);
      break;
    case 'mp4-4k':
    case 'mp4-1080':
      args.push(
        '-vf',
        'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-pix_fmt',
        'yuv420p',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '22',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-movflags',
        '+faststart',
        outputPath
      );
      break;
    case 'mp4-720':
      args.push(
        '-vf',
        'scale=-2:min(720\\,ih)',
        '-pix_fmt',
        'yuv420p',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '24',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        outputPath
      );
      break;
    case 'webm':
      args.push(
        '-vf',
        'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-c:v',
        'libvpx-vp9',
        '-deadline',
        'realtime',
        '-cpu-used',
        '4',
        '-crf',
        '30',
        '-b:v',
        '0',
        '-c:a',
        'libopus',
        outputPath
      );
      break;
    case 'mkv':
    case 'mov':
      args.push(
        '-vf',
        'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-pix_fmt',
        'yuv420p',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-c:a',
        'aac',
        ...(formatId === 'mov' ? ['-movflags', '+faststart'] : []),
        outputPath
      );
      break;
    case 'gif':
      args.push('-t', '12', '-vf', 'fps=12,scale=480:-2:flags=lanczos', '-loop', '0', outputPath);
      break;
    case 'png':
      args.push('-frames:v', '1', outputPath);
      break;
    case 'jpg':
      args.push('-frames:v', '1', '-q:v', '2', outputPath);
      break;
    case 'webp':
      args.push('-frames:v', '1', '-c:v', 'libwebp', '-q:v', '85', outputPath);
      break;
    default:
      args.push(outputPath);
      break;
  }
  return args;
}

export function formatIdToExtension(formatId: TargetFormatId): string {
  if (formatId.startsWith('mp4-')) return 'mp4';
  if (formatId.startsWith('mp3-')) return 'mp3';
  return formatId;
}

/**
 * Stream-based FFmpeg transcoding directly from an external HTTP/HLS URL.
 * Supports arbitrary duration (3 minutes, 1 hour, 2+ hours) without buffering gigabytes into Node RAM.
 */
export async function runFfmpegStreamToTempFile(params: {
  streamUrl: string;
  targetFormat: TargetFormatId;
  title?: string;
  artist?: string;
}): Promise<{
  outputPath: string;
  mimeType: string;
  ext: string;
  sizeBytes: number;
  cleanup: () => Promise<void>;
}> {
  const safeUrl = isSafeExternalHttpUrl(params.streamUrl);
  if (!safeUrl) {
    throw new Error('Blocked unsafe or invalid stream URL.');
  }
  const outExt = formatIdToExtension(params.targetFormat);
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bluedrop-stream-'));
  const outputPath = path.join(tmpDir, `output.${outExt}`);
  const cleanup = async (): Promise<void> => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  };

  try {
    const args = [
      '-user_agent',
      USER_AGENT,
      ...buildFfmpegArgs(safeUrl.toString(), outputPath, params.targetFormat, {
        title: params.title,
        artist: params.artist,
      }),
    ];

    await new Promise<void>((resolve, reject) => {
      const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
        if (stderr.length > 4000) stderr = stderr.slice(-4000);
      });
      child.on('error', (err) => reject(err));
      child.on('close', (code) => {
        if (code === 0 && fs.existsSync(outputPath)) {
          resolve();
        } else {
          reject(new Error(`FFmpeg stream exited with code ${code}: ${stderr.slice(-300)}`));
        }
      });
    });

    const stat = await fs.promises.stat(outputPath);
    return {
      outputPath,
      mimeType: getMimeForExt(outExt),
      ext: outExt,
      sizeBytes: stat.size,
      cleanup,
    };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

export async function runFfmpegTranscode(params: {
  inputBuffer: Buffer;
  inputExt: string;
  targetFormat: TargetFormatId;
  title?: string;
  artist?: string;
}): Promise<{ outputBuffer: Buffer; mimeType: string; ext: string }> {
  const { inputBuffer, inputExt, targetFormat, title, artist } = params;
  const outExt = formatIdToExtension(targetFormat);
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bluedrop-'));
  const cleanInExt = inputExt.replace(/[^a-z0-9]/gi, '').slice(0, 6) || 'bin';
  const inputPath = path.join(tmpDir, `input.${cleanInExt}`);
  const outputPath = path.join(tmpDir, `output.${outExt}`);

  try {
    await fs.promises.writeFile(inputPath, inputBuffer);
    const args = buildFfmpegArgs(inputPath, outputPath, targetFormat, { title, artist });

    await new Promise<void>((resolve, reject) => {
      const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
        if (stderr.length > 4000) stderr = stderr.slice(-4000);
      });
      child.on('error', (err) => reject(err));
      child.on('close', (code) => {
        if (code === 0 && fs.existsSync(outputPath)) {
          resolve();
        } else {
          reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-300)}`));
        }
      });
    });

    const outputBuffer = await fs.promises.readFile(outputPath);
    return {
      outputBuffer,
      mimeType: getMimeForExt(outExt),
      ext: outExt,
    };
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function downloadRemoteBuffer(urlStr: string): Promise<{
  buffer: Buffer;
  contentType: string;
  ext: string;
}> {
  const safeUrl = isSafeExternalHttpUrl(urlStr);
  if (!safeUrl) {
    throw new Error('Blocked unsafe or invalid download URL.');
  }
  const resp = await fetchWithTimeout(safeUrl.toString(), {}, 20000);
  if (!resp.ok || !resp.body) {
    throw new Error(`Remote media source returned HTTP ${resp.status}.`);
  }

  const contentType = (resp.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!;
  const reader = resp.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_REMOTE_MEDIA_BYTES) {
        throw new Error('Remote media exceeds 140MB buffer cap; use direct streaming.');
      }
      chunks.push(Buffer.from(value));
    }
  }

  const extFromPath = path.extname(safeUrl.pathname).replace('.', '').toLowerCase();
  const extFromMime = contentType.split('/')[1]?.replace('mpeg', 'mp3').replace('jpeg', 'jpg') ?? 'bin';
  return {
    buffer: Buffer.concat(chunks),
    contentType,
    ext: extFromPath || extFromMime || 'bin',
  };
}
