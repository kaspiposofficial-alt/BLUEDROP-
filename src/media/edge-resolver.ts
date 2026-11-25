/**
 * Client-Side Device Access Node & Embodied Memory Vault (`src/media/edge-resolver.ts`)
 *
 * Uses the user's browser/device (residential IP + local IndexedDB) as a distributed
 * sensory body and edge access node ("مصادر الوصول") when datacenter IPs are throttled.
 */

import type { MahsoodaKnowledgeCard, MediaInspectResult } from '../../contracts/media.js';

export interface EdgeResolveResult {
  resolvedOnDevice: boolean;
  nodeLabel: string;
  directVideoUrl?: string;
  directAudioUrl?: string;
  durationSec?: number;
}

const CLIENT_PIPED_NODES = [
  'https://pipedapi.kavin.rocks',
  'https://api.piped.private.coffee',
  'https://pipedapi.tokhmi.xyz',
];

function extractYtId(urlStr: string): string | null {
  try {
    const u = new URL(urlStr);
    if (u.hostname.includes('youtu.be')) {
      const id = u.pathname.replace(/^\/+/, '').split('/')[0];
      return id && /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
    }
    if (u.hostname.includes('youtube.com')) {
      const v = u.searchParams.get('v');
      if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;
      const segs = u.pathname.split('/').filter(Boolean);
      if ((segs[0] === 'shorts' || segs[0] === 'live') && segs[1]) return segs[1];
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Probes open CORS-enabled access nodes directly from the user's device IP
 * when the cloud server could not resolve a direct video/audio stream.
 */
export async function resolveStreamFromDeviceEdge(
  media: MediaInspectResult
): Promise<EdgeResolveResult> {
  if (typeof window === 'undefined' || (media.directVideoUrl && media.directAudioUrl)) {
    return {
      resolvedOnDevice: false,
      nodeLabel: 'server-verified',
      directVideoUrl: media.directVideoUrl,
      directAudioUrl: media.directAudioUrl,
      durationSec: media.durationSec,
    };
  }

  if (media.platform === 'youtube') {
    const vid = extractYtId(media.sourceUrl);
    if (vid) {
      for (const node of CLIENT_PIPED_NODES) {
        try {
          const resp = await fetch(`${node}/streams/${vid}`, {
            signal: AbortSignal.timeout(3200),
          });
          if (!resp.ok) continue;
          const json = (await resp.json()) as {
            duration?: number;
            audioStreams?: Array<{ url?: string; bitrate?: number }>;
            videoStreams?: Array<{ url?: string; videoOnly?: boolean }>;
          };
          const bestAudio = (json.audioStreams ?? []).sort(
            (a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0)
          )[0]?.url;
          const bestVideo =
            json.videoStreams?.find((v) => !v.videoOnly && v.url)?.url ??
            json.videoStreams?.find((v) => v.url)?.url;
          if (bestVideo || bestAudio) {
            return {
              resolvedOnDevice: true,
              nodeLabel: `device-edge:${new URL(node).hostname}`,
              directVideoUrl: bestVideo,
              directAudioUrl: bestAudio,
              durationSec: json.duration && json.duration > 0 ? json.duration : media.durationSec,
            };
          }
        } catch {
          // try next edge node from user residential IP
        }
      }
    }
  }

  if (media.platform === 'audius' && media.title) {
    try {
      const resp = await fetch(
        `https://api.audius.co/v1/tracks/search?query=${encodeURIComponent(media.title)}&app_name=BLUEDROP&limit=3`,
        { signal: AbortSignal.timeout(3500) }
      );
      if (resp.ok) {
        const json = (await resp.json()) as { data?: Array<{ id?: string; duration?: number }> };
        const first = json.data?.find((t) => Boolean(t.id));
        if (first?.id) {
          const streamUrl = `https://api.audius.co/v1/tracks/${encodeURIComponent(first.id)}/stream?app_name=BLUEDROP`;
          return {
            resolvedOnDevice: true,
            nodeLabel: 'device-edge:api.audius.co',
            directAudioUrl: streamUrl,
            durationSec: first.duration && first.duration > 0 ? first.duration : media.durationSec,
          };
        }
      }
    } catch {
      // ignore
    }
  }

  return {
    resolvedOnDevice: false,
    nodeLabel: 'device-telemetry-only',
  };
}

const DB_NAME = 'bluedrop_device_body';
const STORE_NAME = 'experiences';

function openVaultDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function persistEmbodiedDeviceMemory(
  card: MahsoodaKnowledgeCard
): Promise<number> {
  if (typeof window === 'undefined' || typeof indexedDB === 'undefined') return 0;
  try {
    const db = await openVaultDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put({
        id: `${card.sourceUrl}#${card.eventType ?? 'inspect'}#${Date.now()}`,
        ...card,
        deviceCores: navigator.hardwareConcurrency ?? 4,
        savedAt: new Date().toISOString(),
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    const count = await countEmbodiedDeviceMemories(db);
    db.close();
    return count;
  } catch {
    return 0;
  }
}

export async function getEmbodiedDeviceMemoryCount(): Promise<number> {
  if (typeof window === 'undefined' || typeof indexedDB === 'undefined') return 0;
  try {
    const db = await openVaultDb();
    const count = await countEmbodiedDeviceMemories(db);
    db.close();
    return count;
  } catch {
    return 0;
  }
}

function countEmbodiedDeviceMemories(db: IDBDatabase): Promise<number> {
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).count();
    req.onsuccess = () => resolve(req.result || 0);
    req.onerror = () => resolve(0);
  });
}
