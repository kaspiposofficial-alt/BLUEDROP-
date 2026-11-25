/**
 * On-Device User Media Library & Instagram-style Collections (`src/media/device-library.ts`)
 *
 * Stores user-saved tracks, videos, albums, and uploaded local media blobs 100%
 * inside the user's own browser IndexedDB (`bluedrop_device_library`) — zero
 * media files are stored on the server. Supports custom named Save Folders ("Collections"),
 * search, isolation, lyrics caching, and offline background playback.
 */

import type { MediaKind, MediaPlatform } from '../../contracts/index.js';

export type LibraryCategory = 'music' | 'video' | 'albums' | 'favorites' | 'uploads';

export interface DeviceLibraryItem {
  id: string;
  title: string;
  creator: string;
  platform: MediaPlatform;
  kind: MediaKind;
  category: LibraryCategory;
  folderName?: string;
  albumOrTag: string;
  durationSec: number;
  durationLabel: string;
  sourceUrl: string;
  streamUrl?: string;
  directVideoUrl?: string;
  directAudioUrl?: string;
  embedPlayerUrl?: string;
  thumbnailUrl?: string;
  description?: string;
  keywords?: string[];
  transcriptText?: string;
  extractorNote?: string;
  lyricsText?: string;
  localBlob?: Blob;
  mimeType?: string;
  fileSizeBytes?: number;
  savedAt: string;
  isolated?: boolean;
}

export function inferCategoryFromFolder(folderName: string, kind: MediaKind): LibraryCategory {
  const lower = folderName.trim().toLowerCase();
  if (lower === 'music' || lower === 'audio' || lower === 'songs') return 'music';
  if (lower.includes('video') || lower.includes('reel')) return 'video';
  if (lower === 'albums' || lower.includes('album')) return 'albums';
  if (lower === 'favorites' || lower.includes('fav')) return 'favorites';
  return kind === 'audio' ? 'music' : kind === 'image' ? 'uploads' : 'video';
}

const DB_NAME = 'bluedrop_device_library';
const STORE_NAME = 'library_items';
const FOLDERS_KEY = 'bluedrop_saved_folders_v1';
const DEFAULT_FOLDERS = ['Favorites', 'Music', 'Reels & Video', 'Albums', 'Late Night'];

export function listSaveFolders(): string[] {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    return [...DEFAULT_FOLDERS];
  }
  try {
    const raw = localStorage.getItem(FOLDERS_KEY);
    if (!raw) return [...DEFAULT_FOLDERS];
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      const merged = Array.from(
        new Set([...DEFAULT_FOLDERS, ...parsed.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)])
      );
      return merged;
    }
  } catch {
    // ignore
  }
  return [...DEFAULT_FOLDERS];
}

export function createSaveFolder(rawName: string): string[] {
  const clean = rawName.trim().slice(0, 32);
  const current = listSaveFolders();
  if (!clean || current.some((f) => f.toLowerCase() === clean.toLowerCase())) {
    return current;
  }
  const next = [...current, clean];
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(FOLDERS_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  }
  return next;
}

function openLibraryDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('savedAt', 'savedAt', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listDeviceLibrary(): Promise<DeviceLibraryItem[]> {
  if (typeof window === 'undefined' || typeof indexedDB === 'undefined') return [];
  try {
    const db = await openLibraryDb();
    const items = await new Promise<DeviceLibraryItem[]>((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => resolve((req.result as DeviceLibraryItem[]) || []);
      req.onerror = () => resolve([]);
    });
    db.close();
    return items.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
  } catch {
    return [];
  }
}

export async function saveToDeviceLibrary(item: DeviceLibraryItem): Promise<void> {
  if (typeof window === 'undefined' || typeof indexedDB === 'undefined') return;
  try {
    const db = await openLibraryDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(item);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Ignore storage quota errors gracefully
  }
}

export async function updateDeviceLibraryItem(
  id: string,
  patch: Partial<
    Pick<
      DeviceLibraryItem,
      | 'category'
      | 'folderName'
      | 'albumOrTag'
      | 'isolated'
      | 'title'
      | 'creator'
      | 'streamUrl'
      | 'directVideoUrl'
      | 'directAudioUrl'
      | 'embedPlayerUrl'
      | 'thumbnailUrl'
      | 'description'
      | 'keywords'
      | 'transcriptText'
      | 'extractorNote'
      | 'lyricsText'
      | 'durationSec'
      | 'durationLabel'
    >
  >
): Promise<void> {
  if (typeof window === 'undefined' || typeof indexedDB === 'undefined') return;
  try {
    const db = await openLibraryDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const existing = getReq.result as DeviceLibraryItem | undefined;
        if (existing) {
          store.put({ ...existing, ...patch });
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // ignore
  }
}

export async function removeFromDeviceLibrary(id: string): Promise<void> {
  if (typeof window === 'undefined' || typeof indexedDB === 'undefined') return;
  try {
    const db = await openLibraryDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // ignore
  }
}

export async function getDeviceStorageUsageSummary(): Promise<{
  usedMb: number;
  quotaMb: number;
}> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
    return { usedMb: 0, quotaMb: 0 };
  }
  try {
    const est = await navigator.storage.estimate();
    return {
      usedMb: Number(((est.usage ?? 0) / (1024 * 1024)).toFixed(1)),
      quotaMb: Number(((est.quota ?? 0) / (1024 * 1024)).toFixed(0)),
    };
  } catch {
    return { usedMb: 0, quotaMb: 0 };
  }
}
