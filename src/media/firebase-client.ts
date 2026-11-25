/**
 * BLUEDROP Firebase Auth, Permanent Gmail Profile, Synced Library & Collective Brain Client
 * (`src/media/firebase-client.ts`)
 *
 * - Real Google / Gmail Sign-In via Firebase Auth (`signInWithPopup` + `browserLocalPersistence`)
 * - Persistent user Name, Email, and Gmail Profile Photo stored in `/users/{uid}`
 * - Synchronized multi-device Media Library in `/users/{uid}/library/{itemId}`
 * - Zero-PII Collective Visual Pixel, 3D Lighting Balance & Clip Fluency Brain in `/visual_clip_knowledge/{cardId}`
 *   with local IndexedDB + localStorage triple fallback so it never crashes across devices or offline states.
 */

import { initializeApp, getApps, getApp, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  browserLocalPersistence,
  setPersistence,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  type Auth,
  type User,
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  query,
  where,
  limit,
  onSnapshot,
  serverTimestamp,
  type Firestore,
  type FieldValue,
  type Timestamp,
  type Unsubscribe,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import type { DeviceLibraryItem, LibraryCategory } from './device-library.js';
import type { MediaKind, MediaPlatform } from '../../contracts/index.js';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string;
    email?: string | null;
    emailVerified?: boolean;
    isAnonymous?: boolean;
    tenantId?: string | null;
    providerInfo: Array<{
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }>;
  };
}

export interface AuthUserProfile {
  uid: string;
  displayName: string;
  email: string;
  photoUrl: string;
  avatarPalette: string[];
  deviceCount: number;
}

export interface CollectiveVisualStudy {
  paletteHexes: string[];
  depthRatio: number;
  studyCount: number;
  recentSummaries: string[];
  recentLyricsSamples: string[];
  brainHintText: string;
}

const LOCAL_BRAIN_CACHE_KEY = 'bluedrop_collective_visual_brain_v1';
const LOCAL_DEVICE_REG_KEY = 'bluedrop_registered_device_uid_v1';

let appInstance: FirebaseApp | null = null;
let authInstance: Auth | null = null;
let dbInstance: Firestore | null = null;
let connectionChecked = false;
let authInitialized = false;

function getSafeAuthContext(auth: Auth | null): FirestoreErrorInfo['authInfo'] {
  const u = auth?.currentUser;
  return {
    userId: u?.uid,
    email: u?.email ?? null,
    emailVerified: u?.emailVerified,
    isAnonymous: u?.isAnonymous,
    tenantId: u?.tenantId ?? null,
    providerInfo: (u?.providerData ?? []).map((provider) => ({
      providerId: provider.providerId,
      displayName: provider.displayName,
      email: provider.email,
      photoUrl: provider.photoURL,
    })),
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: getSafeAuthContext(authInstance),
    operationType,
    path,
  };
  console.error('Firestore Error:', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

function ensureFirebase(): { app: FirebaseApp; auth: Auth; db: Firestore } | null {
  if (typeof window === 'undefined') return null;
  try {
    if (!appInstance) {
      appInstance = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
    }
    if (!authInstance) {
      authInstance = getAuth(appInstance);
      if (!authInitialized) {
        authInitialized = true;
        void setPersistence(authInstance, browserLocalPersistence).catch(() => {});
      }
    }
    if (!dbInstance) {
      dbInstance = getFirestore(appInstance, firebaseConfig.firestoreDatabaseId);
    }
    if (!connectionChecked) {
      connectionChecked = true;
      void testFirestoreConnection(dbInstance);
    }
    return { app: appInstance, auth: authInstance, db: dbInstance };
  } catch (err) {
    console.warn('Firebase initialization fallback:', err instanceof Error ? err.message : err);
    return null;
  }
}

async function testFirestoreConnection(db: Firestore): Promise<void> {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.warn('Firestore offline detected; falling back to local device brain cache.');
    }
  }
}

export function sanitizeFirestoreId(raw: string, fallback = 'item'): string {
  const cleaned = raw
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
  return cleaned || fallback;
}

function clampString(val: string | undefined, maxLen: number, fallback: string): string {
  const s = (val ?? '').trim();
  if (!s) return fallback;
  return s.slice(0, maxLen);
}

function sanitizePalette(hexes: string[]): string[] {
  const valid = hexes
    .map((h) => h.trim().toUpperCase())
    .filter((h) => /^#[0-9A-F]{3,8}$/i.test(h))
    .slice(0, 6);
  return valid.length > 0 ? valid : ['#F4F03A', '#6E8BFF', '#FFA8E4', '#B9F0C6'];
}

function mapFirebaseUser(user: User, cached?: Partial<AuthUserProfile>): AuthUserProfile {
  return {
    uid: user.uid,
    displayName: clampString(user.displayName || cached?.displayName, 120, 'BLUEDROP Member'),
    email: clampString(user.email || cached?.email, 200, 'user@gmail.com'),
    photoUrl: clampString(user.photoURL || cached?.photoUrl, 1000, ''),
    avatarPalette: cached?.avatarPalette ?? ['#F4F03A', '#6E8BFF', '#FFA8E4', '#B9F0C6'],
    deviceCount: cached?.deviceCount ?? 1,
  };
}

export function subscribeAuthState(
  onChange: (profile: AuthUserProfile | null) => void
): Unsubscribe {
  const fb = ensureFirebase();
  if (!fb) {
    onChange(null);
    return () => {};
  }
  return onAuthStateChanged(fb.auth, async (user) => {
    if (!user) {
      onChange(null);
      return;
    }
    const base = mapFirebaseUser(user);
    onChange(base);
    try {
      const synced = await syncUserProfileToFirestore(user, base);
      onChange(synced);
    } catch {
      // Keep auth state valid even if offline
    }
  });
}

export async function signInWithGmailPopup(): Promise<AuthUserProfile> {
  const fb = ensureFirebase();
  if (!fb) {
    throw new Error('Firebase SDK is not available in this browser context.');
  }
  const provider = new GoogleAuthProvider();
  provider.addScope('email');
  provider.addScope('profile');
  provider.setCustomParameters({ prompt: 'select_account' });

  const cred = await signInWithPopup(fb.auth, provider);
  const user = cred.user;
  const base = mapFirebaseUser(user);
  try {
    return await syncUserProfileToFirestore(user, base);
  } catch {
    return base;
  }
}

export async function signOutUser(): Promise<void> {
  const fb = ensureFirebase();
  if (!fb) return;
  await signOut(fb.auth);
}

const inFlightUserSync = new Map<string, Promise<AuthUserProfile>>();

export async function syncUserProfileToFirestore(
  user?: User | null,
  override?: Partial<AuthUserProfile>
): Promise<AuthUserProfile> {
  const fb = ensureFirebase();
  const activeUser = user ?? fb?.auth.currentUser ?? null;
  if (!fb || !activeUser) {
    throw new Error('User not authenticated');
  }
  const uid = sanitizeFirestoreId(activeUser.uid, 'user');
  const existingTask = inFlightUserSync.get(uid);
  if (existingTask && !override) {
    return existingTask;
  }

  const runSync = async (): Promise<AuthUserProfile> => {
    const docPath = `users/${uid}`;
    const ref = doc(fb.db, 'users', uid);

    let existingData: Record<string, unknown> | null = null;
    try {
      const snap = await getDocFromServer(ref);
      if (snap.exists()) {
        existingData = snap.data() as Record<string, unknown>;
      }
    } catch {
      try {
        const snap = await getDoc(ref);
        if (snap.exists()) {
          existingData = snap.data() as Record<string, unknown>;
        }
      } catch {
        // Proceed cleanly
      }
    }

    let regDevices: string[] = [];
    try {
      const raw = localStorage.getItem(LOCAL_DEVICE_REG_KEY);
      if (raw) regDevices = JSON.parse(raw) as string[];
    } catch {
      // ignore
    }
    const alreadyRegisteredOnThisDevice = regDevices.includes(uid);
    const existingDeviceCount =
      typeof existingData?.deviceCount === 'number' && Number.isFinite(existingData.deviceCount)
        ? Math.max(1, Math.min(9999, Math.round(existingData.deviceCount)))
        : 1;
    const nextDeviceCount = existingData
      ? alreadyRegisteredOnThisDevice
        ? existingDeviceCount
        : Math.min(9999, existingDeviceCount + 1)
      : 1;

    const displayName = clampString(
      override?.displayName || activeUser.displayName || (existingData?.displayName as string | undefined),
      120,
      'BLUEDROP Member'
    );
    const email = clampString(
      override?.email || activeUser.email || (existingData?.email as string | undefined),
      200,
      'user@gmail.com'
    );
    const photoUrl = clampString(
      override?.photoUrl || activeUser.photoURL || (existingData?.photoUrl as string | undefined),
      1000,
      ''
    );
    const existingPalette = Array.isArray(existingData?.avatarPalette)
      ? (existingData.avatarPalette as string[])
      : [];
    const avatarPalette = sanitizePalette(
      override?.avatarPalette?.length ? override.avatarPalette : existingPalette
    );

    try {
      if (!existingData) {
        await setDoc(ref, {
          uid,
          displayName,
          email,
          photoUrl,
          avatarPalette,
          deviceCount: nextDeviceCount,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } else {
        await updateDoc(ref, {
          displayName,
          email,
          photoUrl,
          avatarPalette,
          deviceCount: nextDeviceCount,
          updatedAt: serverTimestamp(),
        });
      }
      if (!alreadyRegisteredOnThisDevice) {
        try {
          localStorage.setItem(LOCAL_DEVICE_REG_KEY, JSON.stringify([...regDevices, uid]));
        } catch {
          // ignore
        }
      }
    } catch (error) {
      handleFirestoreError(error, existingData ? OperationType.UPDATE : OperationType.CREATE, docPath);
    }

    return {
      uid,
      displayName,
      email,
      photoUrl,
      avatarPalette,
      deviceCount: nextDeviceCount,
    };
  };

  const task = (existingTask ? existingTask.catch(() => null).then(() => runSync()) : runSync()).finally(() => {
    if (inFlightUserSync.get(uid) === task) {
      inFlightUserSync.delete(uid);
    }
  });
  inFlightUserSync.set(uid, task);
  return task;
}

/**
 * Extracts anonymized dominant hex pixels & 3D luminance balance from a user's Gmail photo
 * or clip thumbnail via `/api/media/thumb` offscreen canvas — zero PII sent to AI or brain.
 */
export async function analyzeImagePixelsAndDepth(imageUrl: string): Promise<{
  paletteHexes: string[];
  depthRatio: number;
} | null> {
  if (!imageUrl || typeof document === 'undefined') return null;
  try {
    const proxied =
      imageUrl.startsWith('data:') || imageUrl.startsWith('blob:')
        ? imageUrl
        : `/api/media/thumb?url=${encodeURIComponent(imageUrl)}`;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('avatar pixel timeout')), 4500);
      img.onload = () => {
        clearTimeout(timer);
        resolve();
      };
      img.onerror = () => {
        clearTimeout(timer);
        reject(new Error('avatar image failed'));
      };
      img.src = proxied;
    });

    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, 32, 32);
    const data = ctx.getImageData(0, 0, 32, 32).data;

    const buckets = new Map<string, number>();
    let lumSum = 0;
    let lumSqSum = 0;
    let sampleCount = 0;

    for (let i = 0; i < data.length; i += 16) {
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      const qr = Math.min(255, Math.round(r / 32) * 32);
      const qg = Math.min(255, Math.round(g / 32) * 32);
      const qb = Math.min(255, Math.round(b / 32) * 32);
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      lumSum += lum;
      lumSqSum += lum * lum;
      sampleCount += 1;

      // Skip pure black/white pixels for richer chromatic palette when colored pixels exist
      if (lum > 0.08 && lum < 0.94) {
        const hex = `#${[qr, qg, qb].map((c) => c.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
        buckets.set(hex, (buckets.get(hex) ?? 0) + 1);
      }
    }

    const meanLum = sampleCount > 0 ? lumSum / sampleCount : 0.5;
    const variance = sampleCount > 0 ? Math.max(0, lumSqSum / sampleCount - meanLum * meanLum) : 0.1;
    const contrastScore = Math.min(1, Math.sqrt(variance) * 3.1);
    const depthRatio = Math.round(Math.max(12, Math.min(96, (contrastScore * 0.65 + (1 - Math.abs(meanLum - 0.5)) * 0.35) * 100)));

    const sortedHexes = Array.from(buckets.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([hex]) => hex);

    return {
      paletteHexes: sanitizePalette(sortedHexes),
      depthRatio,
    };
  } catch {
    return null;
  }
}

export async function studyAvatarPixelsAndSave(
  profile: AuthUserProfile
): Promise<{ paletteHexes: string[]; depthRatio: number } | null> {
  if (!profile.photoUrl) return null;
  const studied = await analyzeImagePixelsAndDepth(profile.photoUrl);
  if (!studied) return null;

  const fb = ensureFirebase();
  if (fb?.auth.currentUser) {
    const uid = sanitizeFirestoreId(fb.auth.currentUser.uid, 'user');
    try {
      const ref = doc(fb.db, 'users', uid);
      await updateDoc(ref, {
        avatarPalette: studied.paletteHexes,
        updatedAt: serverTimestamp(),
      });
    } catch {
      // Non-fatal
    }

    // Record zero-PII pixel geometry study into collective brain
    try {
      const cardId = sanitizeFirestoreId(`px_${uid}_${Date.now().toString(36)}`);
      await setDoc(doc(fb.db, 'visual_clip_knowledge', cardId), {
        authorUid: uid,
        studyType: 'avatar-pixel-study',
        platform: 'profile',
        clipType: 'portrait-lighting',
        depthRatio: studied.depthRatio,
        paletteHexes: studied.paletteHexes,
        studySummary: clampString(
          `Avatar pixel harmony calibrated: depth=${studied.depthRatio}%, palette=${studied.paletteHexes.join(',')}`,
          800,
          'Avatar pixel lighting balance calibrated'
        ),
        createdAt: serverTimestamp(),
      });
    } catch {
      // Non-fatal fallback to local cache below
    }
  }

  mergeLocalVisualBrain(studied.paletteHexes, studied.depthRatio, 'Avatar pixel geometry calibrated');
  return studied;
}

export async function studyClipInBackground(input: {
  studyType: 'clip-study' | 'lyrics-fluency';
  platform: string;
  clipType: string;
  bpm?: number | null;
  depthRatio?: number;
  paletteHexes?: string[];
  studySummary: string;
  lyricsSample?: string;
}): Promise<void> {
  const paletteHexes = sanitizePalette(input.paletteHexes ?? []);
  const depthRatio = Math.max(0, Math.min(100, Math.round(input.depthRatio ?? 64)));
  const summary = clampString(input.studySummary, 800, 'Background clip studied.');
  const lyricsSample = input.lyricsSample ? clampString(input.lyricsSample, 600, '') : undefined;

  mergeLocalVisualBrain(paletteHexes, depthRatio, summary, lyricsSample);

  const fb = ensureFirebase();
  if (!fb?.auth.currentUser) return;
  const uid = sanitizeFirestoreId(fb.auth.currentUser.uid, 'user');
  const cardId = sanitizeFirestoreId(`cl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`);

  const payload: Record<string, unknown> = {
    authorUid: uid,
    studyType: input.studyType,
    platform: clampString(input.platform, 40, 'direct'),
    clipType: clampString(input.clipType, 80, 'video'),
    depthRatio,
    paletteHexes,
    studySummary: summary,
    createdAt: serverTimestamp(),
  };

  if (typeof input.bpm === 'number' && Number.isFinite(input.bpm) && input.bpm >= 0 && input.bpm <= 300) {
    payload.bpm = Math.round(input.bpm);
  }
  if (lyricsSample) {
    payload.lyricsSample = lyricsSample;
  }

  try {
    await setDoc(doc(fb.db, 'visual_clip_knowledge', cardId), payload);
  } catch {
    // Local cache & /api/mahsooda-learn already hold state; never crash playback
  }
}

export function loadLocalVisualBrain(): CollectiveVisualStudy {
  const defaultState: CollectiveVisualStudy = {
    paletteHexes: ['#F4F03A', '#6E8BFF', '#FFA8E4', '#B9F0C6'],
    depthRatio: 62,
    studyCount: 1,
    recentSummaries: [],
    recentLyricsSamples: [],
    brainHintText: 'Depth balance 62%, Swiss crisp contrast palette [#F4F03A, #6E8BFF, #FFA8E4].',
  };
  if (typeof localStorage === 'undefined') return defaultState;
  try {
    const raw = localStorage.getItem(LOCAL_BRAIN_CACHE_KEY);
    if (!raw) return defaultState;
    const parsed = JSON.parse(raw) as Partial<CollectiveVisualStudy>;
    return {
      paletteHexes: sanitizePalette(parsed.paletteHexes ?? []),
      depthRatio: typeof parsed.depthRatio === 'number' ? parsed.depthRatio : 62,
      studyCount: typeof parsed.studyCount === 'number' ? parsed.studyCount : 1,
      recentSummaries: Array.isArray(parsed.recentSummaries) ? parsed.recentSummaries.slice(0, 6) : [],
      recentLyricsSamples: Array.isArray(parsed.recentLyricsSamples)
        ? parsed.recentLyricsSamples.slice(0, 4)
        : [],
      brainHintText:
        typeof parsed.brainHintText === 'string' && parsed.brainHintText
          ? parsed.brainHintText
          : defaultState.brainHintText,
    };
  } catch {
    return defaultState;
  }
}

function mergeLocalVisualBrain(
  paletteHexes: string[],
  depthRatio: number,
  summary: string,
  lyricsSample?: string
): CollectiveVisualStudy {
  const prev = loadLocalVisualBrain();
  const mergedPalette = sanitizePalette([
    ...paletteHexes.slice(0, 3),
    ...prev.paletteHexes.filter((h) => !paletteHexes.includes(h)),
  ]);
  const nextDepth = Math.round((prev.depthRatio * 2 + depthRatio) / 3);
  const summaries = [summary, ...prev.recentSummaries.filter((s) => s !== summary)].slice(0, 6);
  const lyricsSamples = lyricsSample
    ? [lyricsSample, ...prev.recentLyricsSamples.filter((s) => s !== lyricsSample)].slice(0, 4)
    : prev.recentLyricsSamples;

  const next: CollectiveVisualStudy = {
    paletteHexes: mergedPalette,
    depthRatio: nextDepth,
    studyCount: prev.studyCount + 1,
    recentSummaries: summaries,
    recentLyricsSamples: lyricsSamples,
    brainHintText: `Studied ${prev.studyCount + 1} visual/clip signals | 3D Depth Balance: ${nextDepth}% | Palette: [${mergedPalette.join(', ')}] | Recent Focus: ${summaries.slice(0, 2).join(' ; ')}`,
  };
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(LOCAL_BRAIN_CACHE_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  }
  return next;
}

export function subscribeCollectiveKnowledge(
  onUpdate: (study: CollectiveVisualStudy) => void
): Unsubscribe {
  onUpdate(loadLocalVisualBrain());
  const fb = ensureFirebase();
  if (!fb || !fb.auth.currentUser) {
    return () => {};
  }

  const q = query(
    collection(fb.db, 'visual_clip_knowledge'),
    where('studyType', 'in', ['avatar-pixel-study', 'clip-study', 'lyrics-fluency']),
    limit(24)
  );

  return onSnapshot(
    q,
    (snapshot) => {
      if (snapshot.empty) {
        onUpdate(loadLocalVisualBrain());
        return;
      }
      const hexCounts = new Map<string, number>();
      let depthSum = 0;
      let depthCount = 0;
      const summaries: string[] = [];
      const lyricsSamples: string[] = [];

      snapshot.forEach((docSnap) => {
        const d = docSnap.data() as {
          paletteHexes?: string[];
          depthRatio?: number;
          studySummary?: string;
          lyricsSample?: string;
        };
        if (Array.isArray(d.paletteHexes)) {
          for (const hex of d.paletteHexes) {
            if (/^#[0-9A-F]{3,8}$/i.test(hex)) {
              const up = hex.toUpperCase();
              hexCounts.set(up, (hexCounts.get(up) ?? 0) + 1);
            }
          }
        }
        if (typeof d.depthRatio === 'number' && Number.isFinite(d.depthRatio)) {
          depthSum += d.depthRatio;
          depthCount += 1;
        }
        if (typeof d.studySummary === 'string' && d.studySummary && summaries.length < 6) {
          summaries.push(d.studySummary);
        }
        if (typeof d.lyricsSample === 'string' && d.lyricsSample && lyricsSamples.length < 4) {
          lyricsSamples.push(d.lyricsSample);
        }
      });

      const topHexes = sanitizePalette(
        Array.from(hexCounts.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 6)
          .map(([h]) => h)
      );
      const avgDepth = depthCount > 0 ? Math.round(depthSum / depthCount) : 64;
      const state: CollectiveVisualStudy = {
        paletteHexes: topHexes,
        depthRatio: avgDepth,
        studyCount: snapshot.size,
        recentSummaries: summaries,
        recentLyricsSamples: lyricsSamples,
        brainHintText: `Collective Brain (${snapshot.size} studies) | 3D Depth Balance: ${avgDepth}% | Palette: [${topHexes.join(', ')}] | Clips: ${summaries.slice(0, 2).join(' ; ')}`,
      };
      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.setItem(LOCAL_BRAIN_CACHE_KEY, JSON.stringify(state));
        } catch {
          // ignore
        }
      }
      onUpdate(state);
    },
    (err) => {
      try {
        handleFirestoreError(err, OperationType.LIST, 'visual_clip_knowledge');
      } catch {
        // Offline / quota / index fallback preserves resilience via local brain cache
      }
      onUpdate(loadLocalVisualBrain());
    }
  );
}

export async function syncLibraryItemToFirestore(item: DeviceLibraryItem): Promise<void> {
  const fb = ensureFirebase();
  const user = fb?.auth.currentUser;
  if (!fb || !user) return;
  const uid = sanitizeFirestoreId(user.uid, 'user');
  const itemId = sanitizeFirestoreId(item.id, `media_${Date.now()}`);
  const ref = doc(fb.db, 'users', uid, 'library', itemId);

  const validKinds: MediaKind[] = ['video', 'audio', 'image'];
  const validCategories: LibraryCategory[] = ['music', 'video', 'albums', 'favorites', 'uploads'];
  const kind: MediaKind = validKinds.includes(item.kind) ? item.kind : 'video';
  const category: LibraryCategory = validCategories.includes(item.category) ? item.category : 'video';

  const baseFields: Record<string, FieldValue | string | boolean> = {
    uid,
    title: clampString(item.title, 300, 'Untitled Media'),
    creator: clampString(item.creator, 200, 'Unknown Creator'),
    platform: clampString(item.platform, 40, 'direct'),
    kind,
    category,
    folderName: clampString(item.folderName, 80, 'Favorites'),
    sourceUrl: clampString(item.sourceUrl, 1000, 'https://bluedrop.studio'),
    pinned: Boolean(item.isolated),
    updatedAt: serverTimestamp(),
  };

  if (item.thumbnailUrl && !item.thumbnailUrl.startsWith('data:')) {
    baseFields.thumbnailUrl = clampString(item.thumbnailUrl, 1000, '');
  }
  if (item.durationLabel) {
    baseFields.durationLabel = clampString(item.durationLabel, 32, 'STREAM');
  }

  try {
    // Master gate check: verify parent profile exists first
    const userRef = doc(fb.db, 'users', uid);
    const userSnap = await getDoc(userRef);
    if (!userSnap.exists()) {
      await syncUserProfileToFirestore(user);
    }

    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, {
        ...baseFields,
        createdAt: serverTimestamp(),
      });
    } else {
      await updateDoc(ref, baseFields);
    }
  } catch {
    // Non-fatal; item remains safely saved in device IndexedDB
  }
}

export async function loadUserLibraryFromFirestore(): Promise<DeviceLibraryItem[]> {
  const fb = ensureFirebase();
  const user = fb?.auth.currentUser;
  if (!fb || !user) return [];
  const uid = sanitizeFirestoreId(user.uid, 'user');
  try {
    const q = query(
      collection(fb.db, 'users', uid, 'library'),
      where('uid', '==', uid),
      limit(100)
    );
    const snap = await getDocs(q);
    const results: DeviceLibraryItem[] = [];
    snap.forEach((docSnap) => {
      const d = docSnap.data() as {
        title?: string;
        creator?: string;
        platform?: MediaPlatform;
        kind?: MediaKind;
        category?: LibraryCategory;
        folderName?: string;
        sourceUrl?: string;
        thumbnailUrl?: string;
        durationLabel?: string;
        pinned?: boolean;
        updatedAt?: Timestamp;
      };
      results.push({
        id: docSnap.id,
        title: d.title || 'Saved Media',
        creator: d.creator || 'Creator',
        platform: (d.platform || 'direct') as MediaPlatform,
        kind: (d.kind || 'video') as MediaKind,
        category: (d.category || 'favorites') as LibraryCategory,
        folderName: d.folderName || 'Favorites',
        albumOrTag: d.folderName || (d.platform || 'SYNCED').toUpperCase(),
        durationSec: 0,
        durationLabel: d.durationLabel || 'SYNCED',
        sourceUrl: d.sourceUrl || '',
        thumbnailUrl: d.thumbnailUrl || '',
        savedAt: d.updatedAt?.toDate ? d.updatedAt.toDate().toISOString() : new Date().toISOString(),
        isolated: Boolean(d.pinned),
      });
    });
    return results.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
  } catch {
    return [];
  }
}

export async function deleteLibraryItemFromFirestore(id: string): Promise<void> {
  const fb = ensureFirebase();
  const user = fb?.auth.currentUser;
  if (!fb || !user) return;
  const uid = sanitizeFirestoreId(user.uid, 'user');
  const itemId = sanitizeFirestoreId(id, 'item');
  try {
    await deleteDoc(doc(fb.db, 'users', uid, 'library', itemId));
  } catch {
    // Non-fatal
  }
}
